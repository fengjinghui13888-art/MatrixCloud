from __future__ import annotations
import asyncio
import json
from urllib.parse import urlsplit
import httpx
from .safety import ResultUnknown

def validate_cdp_url(url,port):
    u=urlsplit(url)
    if u.scheme!='ws' or u.hostname not in ('127.0.0.1','localhost','::1') or u.port!=int(port) or u.username or u.password: raise ValueError('Chrome 调试地址无效')
    return url

async def browser_version(session,client=None):
    port=session.get('debugPort')
    if not isinstance(port,int) or isinstance(port,bool) or not 1<=port<=65535: raise ValueError('Chrome 调试端口无效')
    own=client is None; client=client or httpx.AsyncClient(follow_redirects=False,trust_env=False)
    try:
        response=await client.get(f'http://127.0.0.1:{port}/json/version',timeout=3,follow_redirects=False); response.raise_for_status(); value=response.json()
        url=validate_cdp_url(value.get('webSocketDebuggerUrl',''),port)
        if session.get('browserUrl') and url!=session['browserUrl']: raise ValueError('Chrome 浏览器身份已改变，已停止连接')
        return value
    finally:
        if own: await client.aclose()

class RawCDP:
    def __init__(self,ws):
        self.ws=ws; self.seq=0; self.pending={}; self.listeners=[]; self.close_listeners=[]; self.closed=False
        self.reader=asyncio.create_task(self._read())
    @classmethod
    async def open(cls,url):
        from websockets.asyncio.client import connect
        return cls(await connect(url,open_timeout=5,max_size=16*1024*1024,proxy=None))
    async def _read(self):
        try:
            async for raw in self.ws:
                message=json.loads(raw)
                future=self.pending.pop(message.get('id'),None)
                if future:
                    if 'error' in message: future.set_exception(ValueError(message['error'].get('message','CDP error')))
                    else: future.set_result(message.get('result',{}))
                elif 'id' not in message:
                    for fn in list(self.listeners): fn(message)
        except asyncio.CancelledError: pass
        except Exception: pass
        finally:
            for future in self.pending.values():
                if not future.done(): future.set_exception(ResultUnknown('Chrome 页面连接断开，执行结果未知'))
            self.pending.clear(); self.closed=True
            for fn in list(self.close_listeners): fn()
    async def send(self,method,params=None,session_id=None):
        if self.closed: raise ResultUnknown('Chrome 页面连接断开')
        self.seq+=1; id=self.seq; future=asyncio.get_running_loop().create_future(); self.pending[id]=future
        message=dict(id=id,method=method,params=params or {})
        if session_id: message['sessionId']=session_id
        try:
            await self.ws.send(json.dumps(message))
            return await asyncio.wait_for(future,15)
        except asyncio.TimeoutError as exc:
            await self.close(); raise ResultUnknown(f'{method} 超时，执行结果未知') from exc
        finally: self.pending.pop(id,None)
    def on_event(self,fn):
        self.listeners.append(fn); return lambda:self.listeners.remove(fn) if fn in self.listeners else None
    def on_close(self,fn): self.close_listeners.append(fn)
    async def close(self):
        self.close_listeners.clear(); self.listeners.clear(); await self.ws.close()
        if self.reader is not asyncio.current_task(): await asyncio.gather(self.reader,return_exceptions=True)

UNREAD_SOURCE = r"""(() => {
 if(location.protocol!=='https:'||!['www.xiaohongshu.com','xiaohongshu.com'].includes(location.hostname))return;
 window.__matrixXhsUnreadObserver?.disconnect();
 const selectors={comments:'[data-notification-kind="comments"][data-unread-count],a[href*="/notification"] [class*="badge"]',messages:'[data-notification-kind="messages"][data-unread-count],a[href*="/message"] [class*="badge"]'};
 const documentId=crypto.randomUUID(),counts={};
 const read=()=>{for(const [kind,selector]of Object.entries(selectors)){let count=null;for(const node of document.querySelectorAll(selector)){const value=node.getAttribute('data-unread-count')??node.textContent?.trim();if(/^\d{1,6}\+?$/.test(value||''))count=Math.max(count??0,Number(value.replace('+','')));}if(count===null)continue;if(counts[kind]!==count){counts[kind]=count;try{window.matrixXhsUnread(JSON.stringify({kind,count,documentId}));}catch{}}}};
 const start=()=>{read();window.__matrixXhsUnreadObserver=new MutationObserver(read);window.__matrixXhsUnreadObserver.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-unread-count','class']});};
 if(document.documentElement)start();else document.addEventListener('DOMContentLoaded',start,{once:true});
})()"""

class PassiveObserver:
    def __init__(self,raw):
        self.raw=raw; self.targets={}; self.listeners=[]; self.close_listeners=[]; self.enabled=False; self.closed=False; self.tasks=set(); self.lock=asyncio.Lock()
        raw.on_event(self.event); raw.on_close(self.disconnected)
    @classmethod
    async def open(cls,session):
        value=await browser_version(session); raw=await RawCDP.open(value['webSocketDebuggerUrl']); observer=cls(raw)
        try:
            await raw.send('Target.setDiscoverTargets',dict(discover=True))
            targets=await raw.send('Target.getTargets')
            for info in targets.get('targetInfos',[]): await observer.attach(info)
            return observer
        except BaseException: await raw.close(); raise
    def spawn(self,coro):
        task=asyncio.create_task(coro); self.tasks.add(task)
        def done(task):
            self.tasks.discard(task)
            if not task.cancelled(): task.exception()
        task.add_done_callback(done)
    async def attach(self,info):
        async with self.lock:
            u=urlsplit(info.get('url','')); id=info.get('targetId')
            accepted=info.get('type')=='page' and u.scheme=='https' and u.hostname in ('creator.xiaohongshu.com','www.xiaohongshu.com','xiaohongshu.com')
            if not accepted: await self.detach(id); return
            if self.closed or id in self.targets: return
            result=await self.raw.send('Target.attachToTarget',dict(targetId=id,flatten=True)); self.targets[id]=dict(sessionId=result['sessionId'])
            if self.enabled: await self.configure(self.targets[id])
    async def configure(self,target):
        sid=target['sessionId']
        for method in ('Network.enable','Page.enable','Runtime.enable'): await self.raw.send(method,{},sid)
        await self.raw.send('Runtime.addBinding',dict(name='matrixXhsUnread'),sid)
        result=await self.raw.send('Page.addScriptToEvaluateOnNewDocument',dict(source=UNREAD_SOURCE),sid); target['scriptId']=result['identifier']
        await self.raw.send('Runtime.evaluate',dict(expression=UNREAD_SOURCE),sid)
    async def detach(self,id):
        target=self.targets.pop(id,None)
        if target and not self.closed:
            try: await self.raw.send('Target.detachFromTarget',dict(sessionId=target['sessionId']))
            except Exception: pass
    def event(self,event):
        method=event.get('method'); params=event.get('params',{})
        if method in ('Target.targetCreated','Target.targetInfoChanged'): self.spawn(self.attach(params['targetInfo'])); return
        if method=='Target.targetDestroyed': self.spawn(self.detach(params['targetId'])); return
        if method=='Target.detachedFromTarget':
            self.targets={id:t for id,t in self.targets.items() if t['sessionId']!=params.get('sessionId')}; return
        id=next((id for id,t in self.targets.items() if t['sessionId']==event.get('sessionId')),None)
        if id:
            for fn in list(self.listeners): fn({**event,'targetId':id})
    def disconnected(self):
        if self.closed: return
        self.closed=True; self.targets.clear()
        for fn in list(self.close_listeners): fn()
    def on_event(self,fn): self.listeners.append(fn)
    def on_close(self,fn): self.close_listeners.append(fn)
    async def send(self,method,params=None,target_id=None):
        if method=='Network.enable':
            self.enabled=True
            for target in list(self.targets.values()): await self.configure(target)
            return
        target=self.targets.get(target_id)
        if not target: raise ValueError('观察目标已关闭')
        return await self.raw.send(method,params,target['sessionId'])
    async def close(self):
        self.closed=True; self.listeners.clear(); self.close_listeners.clear()
        for task in list(self.tasks): task.cancel()
        await asyncio.gather(*list(self.tasks),return_exceptions=True)
        for target in list(self.targets.values()):
            try:
                await self.raw.send('Runtime.evaluate',dict(expression='window.__matrixXhsUnreadObserver?.disconnect()'),target['sessionId'])
                if target.get('scriptId'): await self.raw.send('Page.removeScriptToEvaluateOnNewDocument',dict(identifier=target['scriptId']),target['sessionId'])
                await self.raw.send('Runtime.removeBinding',dict(name='matrixXhsUnread'),target['sessionId'])
            except Exception: pass
        self.targets.clear(); await self.raw.close()
