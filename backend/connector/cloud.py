from __future__ import annotations
import asyncio
import base64
import json
import os
import platform
import socket
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit
import httpx
from app.protocols import (valid_connector_command,valid_xhs_event,valid_xhs_subscriptions,
    MAX_RPC_ACTIVE,MAX_RPC_BYTES,RPC_CHUNK_BYTES,MAX_WS_BYTES,CONNECTOR_VERSION)
from .files import atomic_json, read_json

def normalize_cloud_url(value:str)->str:
    try:
        url=urlsplit(value); port=url.port
    except (ValueError,TypeError) as exc: raise ValueError('云端地址无效') from exc
    if not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('','/') or (url.scheme!='https' and not (url.scheme=='http' and url.hostname in ('localhost','127.0.0.1','::1'))):
        raise ValueError('请使用 HTTPS 网站地址（本机调试可使用 HTTP）')
    host=url.hostname.lower()
    if ':' in host: host='['+host+']'
    suffix='' if port is None or port==({'https':443,'http':80}.get(url.scheme)) else ':'+str(port)
    return f'{url.scheme}://{host}{suffix}'

def resolve_cloud_target(device=None,cloud_url=''):
    target=normalize_cloud_url(cloud_url) if cloud_url else (device or {}).get('cloudUrl','')
    changed=bool(device and normalize_cloud_url(device['cloudUrl'])!=target)
    return dict(cloudUrl=target,device=None if changed else device,requiresPairing=changed)

def load_cloud_device(root:Path):
    value=read_json(Path(root)/'cloud-device.json')
    if value is None: return None
    import re
    if not isinstance(value,dict) or not isinstance(value.get('deviceId'),str) or not re.fullmatch('[a-f0-9]{64}',str(value.get('deviceToken',''))) or not isinstance(value.get('workspace'),str):
        raise ValueError('本机配对文件无效，请重新配对')
    value['cloudUrl']=normalize_cloud_url(value.get('cloudUrl','')); return value

class CloudError(ValueError):
    def __init__(self,message,status): super().__init__(message); self.status=status

async def cloud_request(device,path,*,body=None,client=None):
    base=normalize_cloud_url(device['cloudUrl']); own=client is None
    client=client or httpx.AsyncClient(follow_redirects=False,timeout=15,trust_env=False)
    try:
        headers={'Content-Type':'application/json'}
        if device.get('deviceToken'): headers['Authorization']='Bearer '+device['deviceToken']
        response=await client.post(base+path,json=body or {},headers=headers,follow_redirects=False,timeout=15)
        try: value=response.json()
        except ValueError: value=None
        if not response.is_success: raise CloudError((value or {}).get('message',f'云端连接失败（HTTP {response.status_code}）'),response.status_code)
        if not isinstance(value,dict): raise ValueError('云端返回了无效结果')
        return value
    finally:
        if own: await client.aclose()

async def register_cloud_connector(*,cloud_url,pairing_code,root,device_name=None,client=None):
    import re
    base=normalize_cloud_url(cloud_url)
    if not isinstance(pairing_code,str) or not re.fullmatch(r'\d{8}',pairing_code): raise ValueError('请输入 8 位配对码')
    root=Path(root); root.mkdir(parents=True,exist_ok=True,mode=0o700)
    temp=root/('.cloud-device-'+str(uuid.uuid4()))
    try:
        with temp.open('x') as stream: os.chmod(temp,0o600)
        system={'Windows':'win32','Darwin':'darwin'}.get(platform.system(),'linux')
        result=await cloud_request(dict(cloudUrl=base),'/api/connector/register',client=client,body=dict(code=pairing_code,deviceName=device_name or socket.gethostname(),platform=system,version=CONNECTOR_VERSION))
        if not isinstance(result.get('deviceId'),str) or not re.fullmatch(r'[a-f0-9]{64}',str(result.get('deviceToken',''))) or not isinstance(result.get('workspace'),str): raise ValueError('云端返回了无效配对凭证，请生成新码重试')
        atomic_json(root/'cloud-device.json',dict(cloudUrl=base,deviceId=result['deviceId'],deviceToken=result['deviceToken'],workspace=result['workspace'],createdAt=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())))
        return dict(deviceId=result['deviceId'],workspace=result['workspace'],heartbeatIntervalSeconds=30)
    finally: temp.unlink(missing_ok=True)

class CloudChannel:
    def __init__(self,device,*,root,port,token,client=None,on_watch=None,on_ack=None,on_connected=None,on_revoked=None):
        self.device=device; self.root=Path(root); self.port=port; self.token=token
        self.base=normalize_cloud_url(device['cloudUrl']); self.client=client or httpx.AsyncClient(follow_redirects=False,trust_env=False)
        self.active={}; self.stopped=False; self.socket=None; self.epoch=str(uuid.uuid4()); self.revoked=False
        self.on_watch=on_watch; self.on_ack=on_ack; self.on_connected=on_connected; self.on_revoked=on_revoked
        self.tasks=[]; self.send_lock=asyncio.Lock()
    def lease(self): atomic_json(self.root/'device-lease.json',dict(epoch=self.epoch,until=time.time()*1000+45000))
    async def send(self,ws,message):
        async with self.send_lock: await ws.send(json.dumps(message,separators=(',',':')))
    async def run_request(self,ws,message):
        id=message.get('id'); method=message.get('method'); path=message.get('path','')
        valid=valid_connector_command(method,path,message['body']) if 'body' in message else valid_connector_command(method,path)
        if not isinstance(id,str) or len(id)>256 or id in self.active or len(self.active)>=MAX_RPC_ACTIVE or not valid or (path=='/studio' and message['body'].get('apiBase')!=self.base):
            await self.send(ws,dict(type='error',id=id)); return
        self.active[id]=asyncio.current_task()
        try:
            async with asyncio.timeout(120 if '/media/' in path else 55):
                args=dict(headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'},follow_redirects=False)
                if 'body' in message: args['json']=message['body']
                async with self.client.stream(method,f'http://127.0.0.1:{self.port}'+path,**args) as response:
                    content_type='application/octet-stream' if 'application/octet-stream' in response.headers.get('content-type','') else 'application/json'
                    await self.send(ws,dict(type='head',id=id,status=response.status_code,contentType=content_type))
                    size=0
                    async for part in response.aiter_bytes():
                        size+=len(part)
                        if size>MAX_RPC_BYTES: raise ValueError('本次媒体超过 64 MB 传输上限')
                        for i in range(0,len(part),RPC_CHUNK_BYTES): await self.send(ws,dict(type='chunk',id=id,data=base64.b64encode(part[i:i+RPC_CHUNK_BYTES]).decode()))
                    await self.send(ws,dict(type='end',id=id))
        except asyncio.CancelledError:
            try: await self.send(ws,dict(type='error',id=id))
            except Exception: pass
            raise
        except Exception:
            try: await self.send(ws,dict(type='error',id=id))
            except Exception: pass
        finally: self.active.pop(id,None)
    async def send_event(self,event):
        if not valid_xhs_event(event): raise ValueError('事件格式无效')
        if self.socket is None: raise ValueError('云端通道已断开')
        await self.send(self.socket,dict(type='event',event=event))
    async def revoke(self):
        self.revoked=True; self.stopped=True
        atomic_json(self.root/'device-lease.json',dict(epoch=self.epoch,until=0))
        for task in list(self.active.values()): task.cancel()
        if self.on_revoked: await self.on_revoked()
        if self.socket: await self.socket.close(code=4001,reason='device revoked')
    async def heartbeat(self):
        failures=0
        while not self.stopped:
            try:
                await cloud_request(self.device,'/api/connector/heartbeat',client=self.client)
                failures=0
            except CloudError as exc:
                if exc.status in (401,403,426): await self.revoke(); return
                failures+=1
            except Exception: failures+=1
            await asyncio.sleep(min(120,30*2**min(failures,3)))
    async def run(self):
        from websockets.asyncio.client import connect,ClientConnection
        from websockets.exceptions import ConnectionClosed,InvalidStatus
        failures=0
        while not self.stopped:
            try:
                # Explicit redirect rejection; credentials never follow Location.
                class NoRedirect(connect):
                    def process_redirect(self,exc): return exc
                owner=self
                class LeaseConnection(ClientConnection):
                    def process_event(self,event):
                        from websockets.frames import Frame,Opcode
                        if isinstance(event,Frame) and event.opcode==Opcode.PING: owner.lease()
                        return super().process_event(event)
                async with NoRedirect(self.base.replace('http','ws',1)+'/api/connector/channel',additional_headers={'Authorization':'Bearer '+self.device['deviceToken']},open_timeout=15,max_size=MAX_WS_BYTES,ping_interval=None,create_connection=LeaseConnection) as ws:
                    self.socket=ws; self.lease(); failures=0
                    if self.on_connected: await self.on_connected()
                    async for raw in ws:
                        self.lease(); message=json.loads(raw)
                        if not isinstance(message,dict):raise ValueError('通道消息无效')
                        type=message.get('type')
                        if type=='request':
                            task=asyncio.create_task(self.run_request(ws,message)); self.tasks.append(task)
                            self.tasks=[t for t in self.tasks if not t.done()]
                        elif type=='cancel' and message.get('id') in self.active: self.active[message['id']].cancel()
                        elif type=='watch':
                            if not valid_xhs_subscriptions(message.get('subscriptions')): raise ValueError('事件订阅无效')
                            if self.on_watch: await self.on_watch(message['subscriptions'])
                        elif type=='event-ack' and isinstance(message.get('eventId'),str):
                            if self.on_ack: self.on_ack(message['eventId'])
            except ConnectionClosed as exc:
                if exc.code in (4000,4001,4002): await self.revoke()
            except InvalidStatus as exc:
                if exc.response.status_code in (401,403,426): await self.revoke()
            except (ValueError,TypeError,json.JSONDecodeError):
                if self.socket: await self.socket.close(code=4002,reason='invalid request')
                await self.revoke()
            except asyncio.CancelledError: raise
            except Exception: pass
            finally:
                self.socket=None
                for task in list(self.active.values()): task.cancel()
                await asyncio.gather(*self.tasks,return_exceptions=True); self.tasks=[]
            if not self.stopped:
                await asyncio.sleep(min(60,2**min(failures,6))); failures+=1
    async def close(self):
        self.stopped=True
        if self.socket: await self.socket.close()
        for task in list(self.active.values()): task.cancel()
        await asyncio.gather(*self.tasks,return_exceptions=True)
        await self.client.aclose()
