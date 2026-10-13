"""Authenticated loopback HTTP service compatible with the original connector."""
from __future__ import annotations
import asyncio
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
from fastapi import FastAPI,Request
from fastapi.responses import JSONResponse,HTMLResponse,FileResponse
from app.protocols import PROTOCOL_VERSION,CAPABILITIES,valid_id,valid_uuid
from .browser import BrowserRuntime
from .cloud import load_cloud_device,normalize_cloud_url,resolve_cloud_target,register_cloud_connector,CloudChannel
from .draft import DraftExecutor
from .sync import SyncExecutor
from .jobs import JobManager
from .watch import EventOutbox
from .cleanup import ConnectorCleanup
from .safety import ExecutionGuard
from .files import atomic_json

def health():return dict(ok=True,connector='matrix-cloud-local',version=PROTOCOL_VERSION,capabilities=list(CAPABILITIES))

async def read_json(request:Request,max_bytes=4096):
    parts=[]; size=0
    async for chunk in request.stream():
        size+=len(chunk)
        if size>max_bytes:raise ValueError('请求内容过大')
        parts.append(chunk)
    try:value=json.loads(b''.join(parts) or b'{}')
    except ValueError:raise ValueError('请求格式无效')
    if not isinstance(value,dict):raise ValueError('请求格式无效')
    return value

class ConnectorRuntime:
    def __init__(self,root:Path,cloud_url='',port=47821):
        self.root=Path(root).resolve(); self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        token_path=self.root/'connector-token'
        try:
            with token_path.open('x',encoding='utf8') as stream:os.chmod(token_path,0o600); stream.write(secrets.token_hex(32))
        except FileExistsError:pass
        self.token=token_path.read_text().strip()
        if len(self.token)<32:raise ValueError('本机连接器凭证无效')
        self.cloud_url=normalize_cloud_url(cloud_url) if cloud_url else ''; self.port=port
        self.browser=BrowserRuntime(self.root); self.jobs=JobManager(self.root,sync_executor=SyncExecutor(self.root,self.browser),studio_executor=DraftExecutor(self.root,self.browser))
        self.cleanup=ConnectorCleanup(self.root,self.jobs); self.channel=None; self.watcher=None; self.cloud_tasks=[]; self.cloud_lock=asyncio.Lock()
        self.reconnect_lock=asyncio.Lock(); self.account_locks={}; self.login_tasks={}; self.login_timers={}; self.needs_pairing=False
        self.onboarding=None
    async def start(self):
        persisted=load_cloud_device(self.root); resolved=resolve_cloud_target(persisted,self.cloud_url)
        if resolved['requiresPairing']:self.needs_pairing=True
        elif resolved['device']:await self.connect_cloud(resolved['device'])
        if not resolved['device'] and resolved['cloudUrl'] and self.onboarding is None:self.begin_onboarding(resolved['cloudUrl'])
    async def disconnect_cloud(self):
        if self.channel:await self.channel.close(); self.channel=None
        for task in self.cloud_tasks:task.cancel()
        await asyncio.gather(*self.cloud_tasks,return_exceptions=True); self.cloud_tasks=[]
        if self.watcher:await self.watcher.close(); self.watcher=None
    async def connect_cloud(self,device):
        async with self.cloud_lock:
            await self.disconnect_cloud(); self.needs_pairing=False; self.jobs.allowed_base=device['cloudUrl']
            async def revoked():
                self.needs_pairing=True; self.jobs.allowed_base=''; await self.jobs.close()
                self.begin_onboarding(device['cloudUrl'])
                for task in self.login_tasks.values():task.cancel()
                if self.watcher:await self.watcher.close()
            watcher=EventOutbox(self.root,namespace=normalize_cloud_url(device['cloudUrl'])+'|'+device['deviceId'],get_session=self.browser.observe,is_busy=lambda p:p in self.jobs.profile_jobs or self.jobs.login_owner==p[6:])
            channel=CloudChannel(device,root=self.root,port=self.port,token=self.token,on_watch=watcher.set_subscriptions,on_ack=watcher.ack,on_connected=watcher.replay,on_revoked=revoked)
            watcher.on_event=channel.send_event; self.channel=channel; self.watcher=watcher
            self.jobs.closed=False
            self.cloud_tasks=[asyncio.create_task(channel.run()),asyncio.create_task(channel.heartbeat())]
    def begin_onboarding(self,cloud_url):
        origin=normalize_cloud_url(cloud_url); self.onboarding=dict(origin=origin,secret=secrets.token_hex(32),expires=time.time()+600,used=False,busy=False,failures=0)
        return origin+'/#connectorSetup='+self.onboarding['secret']
    async def pair(self,origin,code,device_name=None):
        result=await register_cloud_connector(cloud_url=origin,pairing_code=code,root=self.root,device_name=device_name)
        await self.connect_cloud(load_cloud_device(self.root)); return result
    def release_login(self,id):
        timer=self.login_timers.pop(id,None)
        if timer:timer.cancel()
        self.jobs.release_login(id)
    async def close(self):
        for task in list(self.login_tasks.values()):task.cancel()
        await asyncio.gather(*list(self.login_tasks.values()),return_exceptions=True)
        for id in list(self.login_timers):self.release_login(id)
        await self.jobs.close(); await self.disconnect_cloud(); await self.browser.close()

def create_connector_app(root:Path,cloud_url:str='',port:int=47821)->FastAPI:
    runtime=ConnectorRuntime(root,cloud_url,port)
    @asynccontextmanager
    async def lifespan(app):
        await runtime.start()
        try:yield
        finally:await runtime.close()
    app=FastAPI(lifespan=lifespan,docs_url=None,redoc_url=None,openapi_url=None); app.state.connector=runtime
    @app.middleware('http')
    async def local_auth(request,call_next):
        if not re.fullmatch(r'(127\.0\.0\.1|localhost)(:\d+)?',request.headers.get('host','')):return JSONResponse({'message':'不支持的本机来源'},403)
        public=request.url.path in ('/health','/','/onboarding')
        if not public:
            candidate=request.headers.get('authorization','').removeprefix('Bearer ')
            if not hmac.compare_digest(candidate.encode(),runtime.token.encode()):return JSONResponse({'message':'本机连接器未授权'},401)
        response=await call_next(request); response.headers['Cache-Control']='no-store'; return response
    @app.exception_handler(ValueError)
    async def invalid(request,exc):return JSONResponse({'message':str(exc)},400)
    @app.get('/health')
    @app.get('/verify')
    async def status():return health()
    @app.get('/')
    async def landing():
        origin=runtime.cloud_url or (load_cloud_device(runtime.root) or {}).get('cloudUrl','')
        paired=bool(load_cloud_device(runtime.root)); title='这台电脑已经完成授权，连接器正在保持云端通道。' if paired else '这台电脑还没有完成工作台授权。'
        setup=runtime.onboarding
        link=setup['origin']+'/#connectorSetup='+setup['secret'] if setup and not setup['used'] else origin+'/' if origin else ''
        return HTMLResponse('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>矩阵云连接器</title><h1>矩阵云连接器正在运行</h1><p>'+title+'</p><p>请返回矩阵云工作台，在“账号矩阵 → 连接你的电脑”点击“授权连接这台电脑”。</p>'+('<a href="'+html.escape(link,quote=True)+'">'+('授权连接这台电脑' if setup and not setup['used'] else '打开矩阵云工作台')+'</a>' if link else '')+'</html>',headers={'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"})
    @app.api_route('/onboarding',methods=['GET','POST'])
    async def onboarding(request:Request):
        state=runtime.onboarding
        if state is None:return HTMLResponse('请从工作台授权连接',403)
        origin=request.headers.get('origin','').rstrip('/'); referer=request.headers.get('referer',''); ru=urlsplit(referer); referer_origin=f'{ru.scheme}://{ru.netloc}' if ru.netloc else ''
        same=origin==state['origin'] or not origin and referer_origin==state['origin']
        if request.method=='GET':
            if (origin or referer_origin) and not same:return HTMLResponse('请从工作台授权连接',403)
            params=request.query_params
        else:
            if not same or not request.headers.get('content-type','').startswith('application/x-www-form-urlencoded'):return HTMLResponse('请从工作台授权连接',403)
            raw=await request.body()
            if len(raw)>2048:return HTMLResponse('授权内容无效',413)
            parsed=parse_qs(raw.decode()); params={k:v[0] for k,v in parsed.items()}
        if state['used'] or state['busy'] or time.time()>state['expires'] or state['failures']>=5:return HTMLResponse('连接授权已使用或过期',409)
        if not hmac.compare_digest(str(params.get('nonce','')),state['secret']) or not re.fullmatch(r'\d{8}',str(params.get('code',''))):state['failures']+=1; return HTMLResponse('连接授权无效',403)
        state['busy']=True
        try:
            await runtime.pair(state['origin'],params['code']); state['used']=True
            return HTMLResponse('电脑已连接，可以返回工作台',headers={'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",'Referrer-Policy':'no-referrer'})
        except Exception:state['failures']+=1; return HTMLResponse('连接未完成，请返回工作台重试',502)
        finally:state['busy']=False
    @app.post('/reconnect')
    async def reconnect(request:Request):
        if runtime.reconnect_lock.locked():return JSONResponse({'message':'连接器正在处理上一条配对请求'},409)
        async with runtime.reconnect_lock:
            input=await read_json(request); code=str(input.get('pairingCode','')).strip(); existing=load_cloud_device(runtime.root)
            if code and not re.fullmatch(r'\d{8}',code):raise ValueError('请输入 8 位配对码')
            target=normalize_cloud_url(input.get('cloudUrl') or runtime.cloud_url or (existing or {}).get('cloudUrl',''))
            resolved=resolve_cloud_target(existing,target)
            if resolved['requiresPairing'] and not code:
                runtime.needs_pairing=True; await runtime.disconnect_cloud()
                if input.get('onboard'):runtime.begin_onboarding(target)
                return JSONResponse(dict(ok=False,requiresPairing=True,message='云端地址已变更，请在新工作台生成配对码后重新授权'),409)
            if existing and not resolved['requiresPairing'] and not runtime.needs_pairing and not code:return dict(ok=True,alreadyPaired=True,message='连接器已在运行且已完成配对，请回到工作台使用')
            if not code:
                url=runtime.begin_onboarding(target) if input.get('onboard') else None
                return JSONResponse(dict(ok=False,requiresPairing=True,message='连接器需要新的配对码，请回到工作台完成授权',**({'onboardingUrl':url} if url else {})),409)
            await runtime.pair(target,code,input.get('deviceName')); return dict(ok=True,message='配对已转交给正在运行的连接器，请回到工作台查看设备状态')
    @app.post('/cleanup')
    async def cleanup(request:Request):
        body=await read_json(request,1024); return runtime.cleanup.apply(body['manifestId']) if body.get('manifestId') else runtime.cleanup.preview()
    @app.post('/studio')
    async def studio(request:Request):
        body=await read_json(request,16384); existing=runtime.jobs.studio_state(body.get('runId',''))
        try:state=await runtime.jobs.submit_studio(body)
        except ValueError as exc:
            if '已有' in str(exc) or '队列已满' in str(exc):return JSONResponse({'message':str(exc)},409)
            raise
        return JSONResponse(state,200 if existing else 202)
    @app.get('/studio/{id}')
    async def studio_state(id:str):
        value=runtime.jobs.studio_state(id); return value if value is not None else JSONResponse({'message':'执行任务不存在'},404)
    @app.post('/studio/{id}/cancel')
    async def studio_cancel(id:str):
        state=await runtime.jobs.cancel('studio',id); return state if state is not None else JSONResponse({'message':'任务不存在'},404)
    @app.post('/sync/{id}')
    async def sync_submit(id:str,request:Request):
        body=await read_json(request,8*1024*1024); existing=runtime.jobs.sync_state(id)
        try:state=await runtime.jobs.submit_sync(id,body)
        except ValueError as exc:
            if '已有' in str(exc):return JSONResponse({'message':str(exc)},409)
            raise
        return JSONResponse(state,200 if existing else 202)
    @app.get('/sync/{id}')
    async def sync_state(id:str):
        value=runtime.jobs.sync_state(id); return value if value is not None else JSONResponse({'message':'同步任务不存在'},404)
    @app.post('/sync/{id}/cancel')
    async def sync_cancel(id:str):
        state=await runtime.jobs.cancel('sync',id); return state if state is not None else JSONResponse({'message':'同步任务不存在'},404)
    @app.get('/sync/{id}/result')
    async def sync_result(id:str):
        from .files import read_json as read_file
        runtime.jobs.path('sync',id); value=read_file(runtime.root/'sync-jobs'/id/'result.json')
        return value if value is not None else JSONResponse({'message':'同步结果尚未生成'},404)
    @app.get('/sync/{id}/media/{asset_id}')
    async def sync_media(id:str,asset_id:str):
        if not re.fullmatch(r'[a-f0-9]{32}',asset_id):return JSONResponse({'message':'媒体编号无效'},404)
        runtime.jobs.path('sync',id)
        try:path=runtime.jobs.media_path(id,asset_id)
        except (FileNotFoundError,ValueError):return JSONResponse({'message':'媒体不属于此任务或路径无效'},404)
        return FileResponse(path,media_type='application/octet-stream')
    @app.api_route('/accounts/{id}/{action}',methods=['GET','POST'])
    async def account(id:str,action:str,request:Request):
        if not valid_id(id):raise ValueError('无效会话编号')
        methods={'login':'POST','state':'GET','connect':'POST','image':'GET','remove':'POST','cancel':'POST','resume':'POST','safety':'GET'}
        if action not in methods:return JSONResponse({'message':'接口不存在'},404)
        if methods[action]!=request.method:return JSONResponse({'message':'请求方式不支持'},405)
        if action=='cancel':
            task=runtime.login_tasks.get(id)
            if task:task.cancel(); await asyncio.gather(task,return_exceptions=True)
            runtime.release_login(id); return dict(status='cancelled',stopConfirmed=True)
        async with runtime.account_locks.setdefault(id,asyncio.Lock()):
            guard=ExecutionGuard(runtime.root,'local:'+id)
            if action=='safety':return guard.status()
            if action=='resume':guard.resume((await read_json(request,1024)).get('confirmed')); return dict(state='normal')
            if action=='login':
                guard.check()
                try:runtime.jobs.reserve_login(id)
                except ValueError as exc:return JSONResponse({'message':str(exc)},409)
                task=asyncio.create_task(runtime.browser.login(id)); runtime.login_tasks[id]=task
                try:
                    value=await task
                    async def expire():await asyncio.sleep(180); runtime.release_login(id)
                    runtime.login_timers[id]=asyncio.create_task(expire()); return JSONResponse(value,201)
                except BaseException:runtime.release_login(id); raise
                finally:runtime.login_tasks.pop(id,None)
            if action=='remove':
                if 'local:'+id in runtime.jobs.profile_jobs:return JSONResponse({'message':'此账号仍有浏览器任务，请先停止'},409)
                runtime.release_login(id)
                await runtime.browser.remove(id)
                return dict(ok=True,accountId=id)
            if action=='connect':
                guard.check(); session=runtime.browser.load(id)
                if not await runtime.browser.live(session):raise ValueError('请点击打开小红书，并在执行电脑完成登录')
                return dict(debugPort=session['debugPort'],profile=session['profile'])
            if action=='image':return await runtime.browser.qr(id)
            state=await runtime.browser.state(id)
            if state.get('loggedIn'):runtime.release_login(id)
            return state
    return app
