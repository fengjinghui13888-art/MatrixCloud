"""Encrypted model profiles and pinned, public-HTTPS provider transports."""
from __future__ import annotations

import asyncio
import base64
import copy
import http.client
import ipaddress
import json
import re
import secrets
import socket
import ssl
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit, quote
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from .store import ServiceError, atomic_write, dumps, identifier, path_lock
from .queues import object_input, text


class ModelRequestError(ServiceError):
    def __init__(self,message,code,status=None):
        super().__init__(message,status or 502);self.code=code;self.provider_status=status


def validate_settings(raw):
    keys=('label','protocol','baseUrl','model','imageModel','imageBaseUrl','imageApiKey','apiKey')
    value=object_input(raw,keys,('label','protocol','baseUrl','model','apiKey'))
    for key,lo,hi in [('label',1,80),('model',1,200),('imageModel',0,200),('apiKey',1,4096),('imageApiKey',1,4096)]:
        if key in value:value[key]=text(value[key],key,lo,hi)
    if value['protocol'] not in ('chat-completions','anthropic-messages'):raise ServiceError('模型协议不合法')
    for key in ('baseUrl','imageBaseUrl'):
        if key in value:
            url=text(value[key],key,1,2048)
            try:
                u=urlsplit(url);u.port
            except ValueError as error:raise ServiceError('模型服务地址无效') from error
            if u.scheme!='https' or not u.hostname or u.username or u.password or u.query or u.fragment:raise ServiceError('只允许公网 HTTPS 域名')
            value[key]=url
    for key in ('apiKey','imageApiKey'):
        if key in value and not re.fullmatch(r'[\x21-\x7e]+',value[key]):raise ServiceError('模型密钥格式不合法')
    if bool(value.get('imageBaseUrl'))!=bool(value.get('imageApiKey')):raise ServiceError('独立生图服务必须同时填写地址和密钥')
    return value


def encode_cipher(key,value):
    iv=secrets.token_bytes(12);cipher=AESGCM(key).encrypt(iv,dumps(value).encode(),None)
    return base64.b64encode(iv+cipher[-16:]+cipher[:-16]).decode()


def decode_cipher(key,value):
    try:
        b=base64.b64decode(value,validate=True)
        if len(b)<29:raise ValueError('short ciphertext')
        return json.loads(AESGCM(key).decrypt(b[:12],b[28:]+b[12:28],None))
    except Exception as error:raise ServiceError('模型配置无法解密，请恢复原密钥和备份',500) from error


_BLOCKED=tuple(ipaddress.ip_network(s) for s in ('0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4'))


async def approved_url(url,allow_query=False):
    try:
        u=urlsplit(url);u.port
    except (ValueError,TypeError) as error:raise ServiceError('只允许公网 HTTPS 域名') from error
    if u.scheme!='https' or not u.hostname or u.username or u.password or u.fragment or (u.query and not allow_query) or u.hostname=='localhost' or u.hostname.endswith('.localhost'):raise ServiceError('只允许公网 HTTPS 域名')
    try:ipaddress.ip_address(u.hostname)
    except ValueError:pass
    else:raise ServiceError('只允许公网 HTTPS 域名')
    try:
        addresses=await asyncio.wait_for(asyncio.to_thread(socket.getaddrinfo,u.hostname,u.port or 443,socket.AF_INET,socket.SOCK_STREAM),5)
    except asyncio.TimeoutError:raise ModelRequestError('服务域名解析超时','TIMEOUT')
    except OSError as error:raise ModelRequestError('模型连接失败：域名无法解析','NETWORK') from error
    ips=list(dict.fromkeys(a[4][0] for a in addresses))
    if not ips or any(any(ipaddress.ip_address(ip) in subnet for subnet in _BLOCKED) for ip in ips):raise ServiceError('禁止访问内网或保留地址')
    return u,ips[0]


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self,host,ip,port,timeout):
        super().__init__(host,port=port,timeout=timeout,context=ssl.create_default_context());self.approved_ip=ip;self.deadline=time.monotonic()+timeout
    def connect(self):
        sock=socket.create_connection((self.approved_ip,self.port),max(.001,self.deadline-time.monotonic()))
        self.deadline_socket=sock
        try:
            remaining=self.deadline-time.monotonic()
            if remaining<=0:raise TimeoutError('provider deadline')
            sock.settimeout(remaining)
            self.sock=self._context.wrap_socket(sock,server_hostname=self.host)
            self.deadline_socket=self.sock
            remaining=self.deadline-time.monotonic()
            if remaining<=0:raise TimeoutError('provider deadline')
            self.sock.settimeout(remaining)
        except BaseException:sock.close();raise


TEXT_TIMEOUT=120
IMAGE_TIMEOUT=180
DOWNLOAD_TIMEOUT=30


def _request(u,ip,headers,body,download=False):
    seconds=DOWNLOAD_TIMEOUT if download else IMAGE_TIMEOUT if re.search(r'/images/(generations|edits)$',u.path) else TEXT_TIMEOUT
    deadline=time.monotonic()+seconds
    limit=8*1024*1024 if download else (24 if re.search(r'/images/(generations|edits)$',u.path) else 1)*1024*1024
    payload=body if isinstance(body,bytes) else dumps(body).encode() if body is not None else None
    hostname=u.hostname.encode('idna').decode('ascii')
    conn=_PinnedHTTPS(hostname,ip,u.port or 443,seconds)
    expired=threading.Event()
    transport=[]
    def expire():
        expired.set()
        # HTTPConnection may clear .sock for Connection: close while response.fp
        # still owns a buffered reader. Retain and shut down the real transport.
        sockets=[*transport,getattr(conn,'sock',None),getattr(conn,'deadline_socket',None)]
        for sock in sockets:
            if sock is not None:
                try:sock.shutdown(socket.SHUT_RDWR)
                except (OSError,AttributeError):pass
        try:conn.close()
        except OSError:pass
    watchdog=threading.Timer(seconds,expire)
    watchdog.daemon=True
    def remaining():
        left=deadline-time.monotonic()
        if left<=0 or expired.is_set():raise TimeoutError('provider deadline')
        if conn.sock:conn.sock.settimeout(left)
    try:
        watchdog.start()
        destination=quote(u.path or '/',safe='/:@%')+('?' + quote(u.query,safe='=&%/:?@+') if u.query else '')
        conn.request('GET' if body is None else 'POST',destination,body=payload,headers={'Content-Type':'application/json',**headers,'Host':hostname+(':'+str(u.port) if u.port else '')})
        if conn.sock:transport.append(conn.sock)
        remaining()
        response=conn.getresponse()
        remaining()
        if not 200<=response.status<300 or download and response.status!=200:
            reasons={503:'服务商暂不可用，请核对当前模型是否仍可用',429:'调用频率或额度受限',401:'密钥无效或已过期',402:'服务商余额不足',404:'接口或模型不存在'}
            raise ModelRequestError(f'模型服务返回 HTTP {response.status}：'+reasons.get(response.status,'请核对模型配置或稍后重试'),'HTTP',response.status)
        chunks=[];size=0
        while True:
            remaining()
            chunk=response.read(65536)
            if not chunk:break
            size+=len(chunk)
            if size>limit:raise ModelRequestError('模型响应超过大小限制' if not download else '生成图片超过 8 MB 归档限制','SIZE_LIMIT')
            chunks.append(chunk)
        data=b''.join(chunks)
        remaining()
        if download:return data
        try:return json.loads(data)
        except (ValueError,UnicodeError) as error:raise ServiceError('模型服务未返回有效 JSON',502) from error
    except (TimeoutError,socket.timeout) as error:raise ModelRequestError(f'模型在 {seconds} 秒内未完成响应；未自动重复扣费，请核对服务商记录后重试','TIMEOUT') from error
    except (OSError,http.client.HTTPException) as error:
        if expired.is_set():raise ModelRequestError(f'模型在 {seconds} 秒内未完成响应；未自动重复扣费，请核对服务商记录后重试','TIMEOUT') from error
        raise ModelRequestError('模型连接失败：连接中断，请稍后重试','NETWORK') from error
    finally:
        watchdog.cancel()
        conn.close()


async def public_https_json(url,headers,body):
    u,ip=await approved_url(url)
    return await asyncio.to_thread(_request,u,ip,headers,body)


async def download_model_image(url):
    u,ip=await approved_url(url,True)
    data=await asyncio.to_thread(_request,u,ip,{},None,True)
    mime='jpeg' if data.startswith(b'\xff\xd8\xff') else 'webp' if data.startswith(b'RIFF') else 'png'
    return 'data:image/'+mime+';base64,'+base64.b64encode(data).decode()


async def call_model(input,prompt,transport=None,max_tokens=512):
    settings=validate_settings(input);prompt=text(prompt,'prompt',1,8000);base=settings['baseUrl'].rstrip('/')
    anthropic=settings['protocol']=='anthropic-messages'
    url=(base if base.endswith('/messages') else base+('/messages' if base.endswith('/v1') else '/v1/messages')) if anthropic else (base if base.endswith('/chat/completions') else base+'/chat/completions')
    headers={'x-api-key':settings['apiKey'],'anthropic-version':'2023-06-01'} if anthropic else {'Authorization':'Bearer '+settings['apiKey']}
    raw=await (transport or public_https_json)(url,headers,dict(model=settings['model'],messages=[dict(role='user',content=prompt)],max_tokens=max_tokens,stream=False))
    try:answer='\n'.join(c.get('text','') for c in raw['content'] if c['type']=='text') if anthropic else raw['choices'][0]['message']['content']
    except (KeyError,IndexError,TypeError):raise ServiceError('模型服务返回格式不合法',502)
    if not isinstance(answer,str) or not answer.strip():raise ServiceError('模型未返回文本；可能需要调整模型或输出限制',502)
    return dict(text=answer,model=settings['model'],provider=settings['label'])


async def generate_images(input,prompt,count=1,transport=None,size='1024x1024'):
    settings=validate_settings(input)
    if not settings.get('imageModel'):raise ServiceError('尚未配置生图模型名，请在模型设置中填写 imageModel')
    base=re.sub(r'/chat/completions$','',(settings.get('imageBaseUrl') or settings['baseUrl']).rstrip('/'))
    url=base if base.endswith('/images/generations') else base+'/images/generations'
    payload=dict(model=settings['imageModel'],prompt=prompt,size=size)
    if urlsplit(url).hostname=='api.agnes-ai.cn':payload['extra_body']={'response_format':'url'}
    else:payload.update(n=min(max(count,1),12),response_format='url')
    raw=await (transport or public_https_json)(url,{'Authorization':'Bearer '+(settings.get('imageApiKey') or settings['apiKey'])},payload)
    if not isinstance(raw,dict) or not isinstance(raw.get('data'),list) or not raw['data']:raise ServiceError('生图服务返回格式不合法',502)
    urls=[x['url'] for x in raw['data'] if isinstance(x,dict) and x.get('url')]
    if not urls:raise ServiceError('生图服务未返回可访问图片地址',502)
    if any(not isinstance(url,str) or not urlsplit(url).scheme or not urlsplit(url).hostname for url in urls):raise ServiceError('生图服务返回图片地址不合法',502)
    return dict(images=urls,model=settings['imageModel'],provider=settings['label'])


async def edit_images(settings,prompt,reference,strength,size='1024x1024',transport=None):
    settings=validate_settings(settings)
    if not re.match(r'^gpt-image-',settings.get('imageModel',''),re.I):raise ServiceError('当前生图服务尚未接入参考图编辑，请切换兼容图片编辑接口的 GPT Image 服务')
    if not .5<=strength<=.7:raise ServiceError('二创强度必须在 0.5–0.7 之间')
    match=re.fullmatch(r'data:image/(png|jpeg|webp);base64,(.+)',reference)
    if not match:raise ServiceError('参考图读取失败')
    try:bytes=base64.b64decode(match[2],validate=True)
    except ValueError:raise ServiceError('参考图读取失败')
    boundary='matrix-'+identifier();chunks=[]
    fields=dict(model=settings['imageModel'],prompt=f'{prompt}\n参考图二次创作。变化意愿 {strength}（0.5 偏保留，0.7 偏变化）。保留主体身份和关键产品细节，调整场景、光线与构图。',n='1',size=size)
    for key,value in fields.items():chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    extension='jpg' if match[1]=='jpeg' else match[1]
    chunks.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="reference.{extension}"\r\nContent-Type: image/{match[1]}\r\n\r\n'.encode(),bytes,f'\r\n--{boundary}--\r\n'.encode()])
    base=re.sub(r'/(images/(generations|edits)|chat/completions)$','',(settings.get('imageBaseUrl') or settings['baseUrl']).rstrip('/'))
    raw=await (transport or public_https_json)(base+'/images/edits',{'Authorization':'Bearer '+(settings.get('imageApiKey') or settings['apiKey']),'Content-Type':'multipart/form-data; boundary='+boundary},b''.join(chunks))
    try:result=raw['data'][0]
    except (KeyError,IndexError,TypeError):raise ServiceError('图片编辑未返回图片',502)
    if not result.get('url') and not result.get('b64_json'):raise ServiceError('图片编辑未返回图片',502)
    return 'data:image/png;base64,'+result['b64_json'] if result.get('b64_json') else result['url']


class Models:
    def __init__(self,root,db=None,tenant='owner'):
        self.root=Path(root);self.path=self.root/'model-settings.enc';self.key_path=self.root/'model-encryption-key';self.db,self.tenant=db,tenant
        self.root.mkdir(parents=True,exist_ok=True,mode=0o700);self.lock=path_lock(self.path)

    def _key(self):
        if not self.key_path.exists():
            existing=self.path.exists()
            if self.db:
                with self.db.transaction(self.tenant) as c:existing=existing or bool(c.execute('SELECT 1 FROM model_config WHERE tenant_id=%s LIMIT 1',(self.tenant,)).fetchone())
            if existing:raise ServiceError('模型配置加密密钥缺失，请恢复备份',500)
            try:
                with self.key_path.open('xb') as file:file.write(secrets.token_bytes(32))
                self.key_path.chmod(0o600)
            except FileExistsError:pass
        key=self.key_path.read_bytes()
        if len(key)!=32:raise ServiceError('模型配置加密密钥无效',500)
        return key

    def _collection(self):
        key=self._key()
        if self.db:
            with self.db.transaction(self.tenant) as c:rows=c.execute('SELECT id,active,ciphertext FROM model_config WHERE tenant_id=%s ORDER BY id',(self.tenant,)).fetchall()
            return dict(activeId=next((r['id'] for r in rows if r['active']),''),profiles=[dict(id=r['id'],settings=validate_settings(decode_cipher(key,r['ciphertext']))) for r in rows])
        if not self.path.exists():return dict(activeId='',profiles=[])
        raw=decode_cipher(key,self.path.read_text(encoding='utf-8'))
        if 'profiles' not in raw:return dict(activeId='default',profiles=[dict(id='default',settings=validate_settings(raw))])
        if not isinstance(raw.get('activeId'),str) or not isinstance(raw['profiles'],list):raise ServiceError('模型配置格式无效',500)
        return dict(activeId=raw['activeId'],profiles=[dict(id=p['id'],settings=validate_settings(p['settings'])) for p in raw['profiles']])

    def read(self):
        with self.lock:
            all=self._collection();return next((copy.deepcopy(p['settings']) for p in all['profiles'] if p['id']==all['activeId']),None)

    @staticmethod
    def _summary(value):return {**{k:v for k,v in value.items() if k not in ('apiKey','imageApiKey')},'hasKey':bool(value.get('apiKey')),'hasImageKey':bool(value.get('imageApiKey'))} if value else None
    def summary(self):return self._summary(self.read())
    def profiles(self):
        with self.lock:
            all=self._collection();return dict(activeId=all['activeId'],profiles=[{'id':p['id'],**{k:p['settings'][k] for k in ('label','model','imageModel') if k in p['settings']}} for p in all['profiles']])

    def activate(self,id):
        with self.lock:
            if self.db:
                with self.db.transaction(self.tenant) as c:
                    c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',(self.tenant+':models',))
                    if not c.execute('SELECT 1 FROM model_config WHERE tenant_id=%s AND id=%s',(self.tenant,id)).fetchone():raise ServiceError('模型配置不存在',404)
                    c.execute('UPDATE model_config SET active=false WHERE tenant_id=%s',(self.tenant,))
                    c.execute('UPDATE model_config SET active=true WHERE tenant_id=%s AND id=%s',(self.tenant,id))
            else:
                all=self._collection()
                if not any(p['id']==id for p in all['profiles']):raise ServiceError('模型配置不存在',404)
                all['activeId']=id;atomic_write(self.path,encode_cipher(self._key(),all).encode())
            return self.summary()

    @staticmethod
    def _incoming(input,previous):
        if not isinstance(input,dict):raise ServiceError('模型配置不合法')
        incoming=copy.deepcopy(input);previous=previous or {}
        normalize=lambda s:s.rstrip('/') if isinstance(s,str) else s
        if 'apiKey' not in incoming and normalize(incoming.get('baseUrl'))==normalize(previous.get('baseUrl')):incoming['apiKey']=previous.get('apiKey')
        if 'imageApiKey' not in incoming and incoming.get('imageBaseUrl') and normalize(incoming['imageBaseUrl'])==normalize(previous.get('imageBaseUrl')):incoming['imageApiKey']=previous.get('imageApiKey')
        value=validate_settings(incoming);value['baseUrl']=value['baseUrl'].rstrip('/');return value

    def save(self,input,as_new=False):
        with self.lock:
            key=self._key()
            if self.db:
                with self.db.transaction(self.tenant) as c:
                    c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',(self.tenant+':models',))
                    rows=c.execute('SELECT id,active,ciphertext FROM model_config WHERE tenant_id=%s',(self.tenant,)).fetchall()
                    old=None if as_new else next((r for r in rows if r['active']),None)
                    value=self._incoming(input,decode_cipher(key,old['ciphertext']) if old else None)
                    if not old and len(rows)>=50:raise ServiceError('最多保存 50 组模型配置')
                    c.execute('UPDATE model_config SET active=false WHERE tenant_id=%s',(self.tenant,))
                    c.execute('INSERT INTO model_config(tenant_id,id,label,active,ciphertext) VALUES(%s,%s,%s,true,%s) ON CONFLICT(tenant_id,id) DO UPDATE SET label=excluded.label,active=true,ciphertext=excluded.ciphertext,updated_at=now()',(self.tenant,old['id'] if old else identifier(),value['label'],encode_cipher(key,value)))
            else:
                all=self._collection();old=None if as_new else next((p for p in all['profiles'] if p['id']==all['activeId']),None)
                value=self._incoming(input,old['settings'] if old else None)
                if old:old['settings']=value
                else:
                    if len(all['profiles'])>=50:raise ServiceError('最多保存 50 组模型配置')
                    id=identifier();all['profiles'].append(dict(id=id,settings=value));all['activeId']=id
                atomic_write(self.path,encode_cipher(key,all).encode())
            return self._summary(value)

    def _required(self):
        settings=self.read()
        if not settings:raise ServiceError('请先配置模型服务')
        return settings
    async def chat(self,prompt,max_tokens=512,transport=None):return await call_model(self._required(),prompt,transport,max_tokens)
    async def images(self,prompt,count=1,size='1024x1024',transport=None):return await generate_images(self._required(),prompt,count,transport,size)
    async def edit_image(self,prompt,reference,strength=.6,transport=None,size='1024x1024'):return await edit_images(self._required(),prompt,reference,strength,size,transport)
    async def download_image(self,url):return await download_model_image(url)
    async def probe(self,input=None):return await call_model(input or self._required(),'请只回复“连接成功”',max_tokens=64)
