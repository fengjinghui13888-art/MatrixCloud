"""Bounded direct Python media downloads; browser cookies remain in memory."""
from __future__ import annotations
import asyncio
import hashlib
import http.client
import ipaddress
import os
import re
import socket
import ssl
import time
from pathlib import Path
from urllib.parse import urlsplit,urljoin,quote,parse_qsl,urlencode
import httpx
from .files import read_json,atomic_json

EXTENSIONS={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif','video/mp4':'.mp4','video/webm':'.webm'}

class MediaHTTPError(ValueError):
    def __init__(self,status):self.status=status;super().__init__('素材下载失败 HTTP '+str(status))

def validate_media_url(value):
    u=urlsplit(value)
    if u.scheme not in ('http','https') or u.username or u.password or u.port not in (None,80,443) or not any(u.hostname==h or (u.hostname or '').endswith('.'+h) for h in ('xhscdn.com','xiaohongshu.com')): raise ValueError('媒体地址不属于小红书')
    return value

def validate_image_url(value,allowed_prefix=''):
    u=urlsplit(value)
    if u.username or u.password or not u.hostname:raise ValueError('图片地址无效')
    if allowed_prefix and value.startswith(allowed_prefix):return value
    if u.scheme!='https' and not (u.scheme=='http' and (u.hostname=='xhscdn.com' or u.hostname.endswith('.xhscdn.com'))): raise ValueError('图片地址不是允许的 HTTPS 或小红书同步素材地址')
    try:
        address=ipaddress.ip_address(u.hostname)
        if not address.is_global:raise ValueError('图片地址不允许访问本机或内网')
    except ValueError as exc:
        if '不允许' in str(exc):raise
    if u.hostname.lower() in ('localhost','metadata.google.internal') or u.hostname.lower().endswith(('.localhost','.local','.internal')):raise ValueError('图片地址不允许访问本机或内网')
    return value

def image_type(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):return 'png'
    if data.startswith(b'\xff\xd8'):return 'jpeg'
    if data[:4]==b'RIFF' and data[8:12]==b'WEBP':return 'webp'

class _PinnedImageHTTPS(http.client.HTTPSConnection):
    def __init__(self,hostname,ip,port):
        super().__init__(hostname,port=port,timeout=20,context=ssl.create_default_context());self.approved_ip=ip
    def connect(self):
        raw=socket.create_connection((self.approved_ip,self.port),20)
        try:self.sock=self._context.wrap_socket(raw,server_hostname=self.host)
        except BaseException:raw.close();raise

async def fetch_pinned_image_bytes(value,*,resolver=None,connection_factory=None):
    """Resolve once, reject every private address, then pin TLS to that public IP."""
    validate_image_url(value); u=urlsplit(value)
    if u.scheme!='https':validate_media_url(value)
    resolver=resolver or socket.getaddrinfo
    try:addresses=await asyncio.wait_for(asyncio.to_thread(resolver,u.hostname,u.port or (443 if u.scheme=='https' else 80),socket.AF_UNSPEC,socket.SOCK_STREAM),5)
    except (OSError,asyncio.TimeoutError):raise ValueError('素材域名无法解析或解析超时')
    ips=list(dict.fromkeys(a[4][0] for a in addresses))
    if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):raise ValueError('图片地址不允许访问本机、内网或保留地址')
    def read():
        port=u.port or (443 if u.scheme=='https' else 80)
        if connection_factory:connection=connection_factory(u.hostname,ips[0],port)
        elif u.scheme=='https':connection=_PinnedImageHTTPS(u.hostname,ips[0],port)
        else:connection=http.client.HTTPConnection(ips[0],port=port,timeout=20)
        try:
            path=quote(u.path or '/',safe='/:@%')+('?' + quote(u.query,safe='=&%/:?@+') if u.query else '')
            connection.request('GET',path,headers={'Host':u.netloc,'User-Agent':'Mozilla/5.0'})
            response=connection.getresponse()
            if not 200<=response.status<300:raise MediaHTTPError(response.status)
            chunks=[];size=0;started=time.monotonic()
            while True:
                chunk=response.read(64*1024)
                if not chunk:break
                size+=len(chunk)
                if size>64*1024*1024 or time.monotonic()-started>20:raise ValueError('素材超过本次下载大小或时间限制')
                chunks.append(chunk)
            return b''.join(chunks)
        finally:connection.close()
    return await asyncio.to_thread(read)

async def download_images(urls,directory:Path,*,client=None,allowed_prefix='',token=''):
    if not isinstance(urls,list) or not 1<=len(urls)<=12:raise ValueError('单个创作任务图片数量须为 1–12 张')
    directory=Path(directory); directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    own=client is None; client=client or httpx.AsyncClient(follow_redirects=False,timeout=20,trust_env=False)
    async def one(index,value):
        validate_image_url(value,allowed_prefix)
        headers={'Authorization':'Bearer '+token} if allowed_prefix and value.startswith(allowed_prefix) and token else {}
        for attempt in range(3):
            try:
                if not allowed_prefix or not value.startswith(allowed_prefix):
                    data=await fetch_pinned_image_bytes(value);type=image_type(data)
                    if not type:raise ValueError(f'第 {index+1} 张素材不是支持的 PNG/JPEG/WebP 图片')
                    name=str(index+1)+('.jpg' if type=='jpeg' else '.'+type);path=directory/name;path.write_bytes(data);os.chmod(path,0o600)
                    return dict(path=str(path),name=name,mime='image/'+type,bytes=len(data))
                async with client.stream('GET',value,headers=headers,follow_redirects=False,timeout=20) as response:
                    if not response.is_success:
                        if attempt<2 and (response.status_code>=500 or response.status_code in (408,429)):await asyncio.sleep(.5*(attempt+1)); continue
                        raise ValueError(f'素材下载失败 HTTP {response.status_code}')
                    chunks=[]; size=0
                    async for chunk in response.aiter_bytes():
                        size+=len(chunk)
                        if size>64*1024*1024:raise ValueError('单张素材超过 64 MB 下载上限')
                        chunks.append(chunk)
                    data=b''.join(chunks); type=image_type(data)
                    if not type:raise ValueError(f'第 {index+1} 张素材不是支持的 PNG/JPEG/WebP 图片')
                    name=str(index+1)+('.jpg' if type=='jpeg' else '.'+type); path=directory/name
                    path.write_bytes(data); os.chmod(path,0o600)
                    return dict(path=str(path),name=name,mime='image/'+type,bytes=len(data))
            except MediaHTTPError as exc:
                if attempt<2 and (exc.status>=500 or exc.status in (408,429)):await asyncio.sleep(.5*(attempt+1));continue
                raise
            except (httpx.TransportError,TimeoutError,OSError,http.client.HTTPException):
                if attempt==2:raise ValueError('素材下载中断，请稍后重试；已生成的文案和图片记录仍保留')
                await asyncio.sleep(.5*(attempt+1))
    try:return await asyncio.gather(*(one(i,url) for i,url in enumerate(urls)))
    finally:
        if own:await client.aclose()

def segment(value):
    if not value or len(str(value))>160:raise ValueError('无效存储编号')
    escaped=quote(str(value),safe='-_').replace('.','%2E')
    if re.fullmatch(r'(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])',escaped):escaped='%'+format(ord(escaped[0]),'02X')+escaped[1:]
    return escaped

def digest(path):
    hash=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):hash.update(chunk)
    return hash.hexdigest()

async def archive_media(*,notes,account_id,root:Path,context,available_assets=None,on_progress=None,guard=None,client=None):
    root=Path(root).resolve(); root.mkdir(parents=True,exist_ok=True,mode=0o700); items=[]; available=set(available_assets or [])
    for note in notes:
        date=str(note.get('publishedAt',''))[:10]
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',date):date='unknown-date'
        if note.get('mediaType')!='video':
            for i,url in enumerate(note.get('images') or []):items.append(dict(noteId=note['id'],date=date,kind='image',url=url,index=i))
        if note.get('cover') and (note.get('mediaType')=='video' or note['cover'] not in (note.get('images') or [])):items.append(dict(noteId=note['id'],date=date,kind='cover',url=note['cover'],index=0))
        if note.get('videoUrl'):items.append(dict(noteId=note['id'],date=date,kind='video',url=note['videoUrl'],index=0))
    cached=[]; missing=[]
    for item in items:
        note=next(n for n in notes if n['id']==item['noteId'])
        exists=any(item['noteId']+':'+a['id'] in available and a.get('kind')==item['kind'] and a.get('index')==item['index'] and a.get('sourceUrl')==item['url'] for a in note.get('mediaAssets',[]))
        (cached if exists else missing).append(item)
    if not missing:return dict(total=len(items),saved=0,cached=len(cached),failed=0,errors=[])
    own=client is None; client=client or httpx.AsyncClient(follow_redirects=False,timeout=httpx.Timeout(25,connect=10),trust_env=False,headers={'User-Agent':'Mozilla/5.0','Referer':'https://www.xiaohongshu.com/'})
    cookies=await asyncio.wait_for(context.cookies(),10)
    for c in cookies:
        domain=c.get('domain','').lstrip('.')
        if any(domain==host or domain.endswith('.'+host) for host in ('xiaohongshu.com','xhscdn.com')):client.cookies.set(c['name'],c['value'],domain=c['domain'],path=c.get('path','/'))
    results=[]; semaphore=asyncio.Semaphore(4)
    async def one(item):
        part=None
        async with semaphore:
            try:
                if guard:guard.check()
                source=validate_media_url(item['url']); u=urlsplit(source); path=u.path.rsplit('/',1)[-1] if 'webpic' in (u.hostname or '') else u.path
                query=urlencode([(k,v) for k,v in parse_qsl(u.query,keep_blank_values=True) if k.lower() not in ('sign','t','expires','token')])
                asset_id=hashlib.sha256('|'.join([item['kind'],u.hostname or '',path,query]).encode()).hexdigest()[:32]
                base=root/segment(account_id)/item['date']/item['kind']/segment(item['noteId'])/asset_id
                if not base.resolve().is_relative_to(root):raise ValueError('媒体路径无效')
                meta=base.with_suffix('.json'); asset=read_json(meta)
                if asset:
                    existing=(root/asset['path']).resolve()
                    if existing.is_relative_to(root) and existing.is_file() and existing.stat().st_size==asset['bytes'] and await asyncio.to_thread(digest,existing)==asset['sha256']:
                        return dict(status='cached',noteId=item['noteId'],asset={**asset,'index':item['index'],'sourceUrl':source})
                current=source
                for redirect in range(5):
                    validate_media_url(current)
                    async with client.stream('GET',current,follow_redirects=False) as response:
                        if response.status_code in (301,302,303,307,308):current=urljoin(current,response.headers.get('location','')); continue
                        response.raise_for_status(); mime=response.headers.get('content-type','').split(';')[0].lower()
                        if mime not in EXTENSIONS or (item['kind']=='video')!=mime.startswith('video/'):raise ValueError('响应不是预期的图片或视频')
                        dest=base.with_suffix(EXTENSIONS[mime]); dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700); part=dest.with_suffix(dest.suffix+'.part')
                        if not dest.resolve().is_relative_to(root) or part.is_symlink():raise ValueError('媒体路径无效')
                        total=0; hash=hashlib.sha256(); start=time.monotonic()
                        with part.open('wb') as stream:
                            os.chmod(part,0o600)
                            async for chunk in response.aiter_bytes(chunk_size=256*1024):
                                if guard:guard.check()
                                if not chunk:continue
                                if total==0:
                                    valid=(chunk.startswith((b'\xff\xd8\xff',b'\x89PNG\r\n\x1a\n',b'GIF8')) or chunk[:4]==b'RIFF') if mime.startswith('image/') else chunk[4:8]==b'ftyp' or chunk.startswith(b'\x1aE\xdf\xa3')
                                    if not valid:raise ValueError('媒体文件头校验失败')
                                total+=len(chunk)
                                if total>1024*1024*1024 or time.monotonic()-start>240:raise ValueError('媒体超过本次下载大小或时间限制')
                                hash.update(chunk); stream.write(chunk)
                            if not total:raise ValueError('媒体响应为空')
                            stream.flush(); os.fsync(stream.fileno())
                        part.replace(dest); part=None
                        asset=dict(id=asset_id,kind=item['kind'],index=item['index'],sourceUrl=source,path=dest.relative_to(root).as_posix(),bytes=total,sha256=hash.hexdigest()); atomic_json(meta,asset)
                        return dict(status='saved',noteId=item['noteId'],asset=asset)
                raise ValueError('媒体重定向超过限制')
            except asyncio.CancelledError:raise
            except Exception as exc:return dict(status='failed',noteId=item['noteId'],kind=item['kind'],index=item['index'],error=str(exc) if isinstance(exc,ValueError) else type(exc).__name__)
            finally:
                if part:part.unlink(missing_ok=True)
    async def work(item):
        result=await one(item); results.append(result)
        if on_progress:await on_progress(dict(total=len(items),finished=len(results),saved=sum(r['status']!='failed' for r in results)))
    try:
        unique={(i['noteId'],i['kind'],i['url']):i for i in missing}
        await asyncio.gather(*(work(item) for item in unique.values()))
        for note in notes:
            assets=[r['asset'] for r in results if r['noteId']==note['id'] and 'asset' in r]
            if assets:note['mediaAssets']=sorted([a for a in note.get('mediaAssets',[]) if not any(a.get('kind')==n['kind'] and a.get('index')==n['index'] for n in assets)]+assets,key=lambda a:a['index'])
        return dict(total=len(items),saved=sum(r['status']=='saved' for r in results),cached=len(cached)+sum(r['status']=='cached' for r in results),failed=sum(r['status']=='failed' for r in results),errors=[r for r in results if r['status']=='failed'])
    finally:
        if own:await client.aclose()
