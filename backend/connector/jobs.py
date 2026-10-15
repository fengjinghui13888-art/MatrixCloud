"""Bounded desktop workers, isolated by browser profile; one writer per account."""
from __future__ import annotations
import asyncio
import time
from collections import deque
from datetime import datetime,timezone
from pathlib import Path
from app.protocols import valid_uuid,valid_profile
from .files import atomic_json,read_json,safe_file
from .safety import ExecutionGuard,ResultUnknown,safe_execution_error

def timestamp(): return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')

class JobManager:
    def __init__(self,root:Path,*,sync_executor=None,studio_executor=None,allowed_base='',max_pending=10):
        self.root=Path(root); self.sync_executor=sync_executor; self.studio_executor=studio_executor
        self.allowed_base=allowed_base; self.max_pending=max_pending; self.now=time.time
        self.pending=deque(); self.active={}; self.worker=None; self.changed=asyncio.Event()
        self.profile_jobs={}; self.state_lock=asyncio.Lock(); self.closed=False
        self.login_owner=None; self.login_released=asyncio.Event(); self.login_released.set()
    def busy(self): return bool(self.active or self.pending or self.login_owner)
    def reserve_login(self,id):
        if self.closed:raise ValueError('连接器正在停止或切换版本，请稍后重试')
        if self.busy(): raise ValueError('此电脑正在执行其他浏览器任务，请先完成或停止后再打开登录')
        self.login_owner=id; self.login_released.clear()
    def release_login(self,id):
        if self.login_owner==id: self.login_owner=None; self.login_released.set()
    def path(self,kind,id):
        if not valid_uuid(id): raise ValueError('无效任务编号')
        return self.root/('sync-jobs' if kind=='sync' else 'studio-jobs')/(id+'/state.json' if kind=='sync' else id+'.json')
    def get(self,kind,id):
        state=read_json(self.path(kind,id))
        if state is None: return None
        owned=(kind,id) in self.active or any(item[0:2]==(kind,id) for item in self.pending)
        if state.get('status') in ('queued','running','stopping') and not owned:
            state.update(status='blocked',stopConfirmed=True,retrySafe=False,message='执行设备重启，原稿已保留；请在原电脑核对草稿，勿重复上传')
            atomic_json(self.path(kind,id),state)
        return state
    def sync_state(self,id): return self.get('sync',id)
    def studio_state(self,id): return self.get('studio',id)
    async def submit_sync(self,id,input):
        target=input.get('target')
        if not isinstance(target,dict) or not valid_profile(target.get('profile')) or not isinstance(target.get('id'),str) or not isinstance(target.get('handle'),str) or not isinstance(input.get('knownNotes'),list): raise ValueError('同步参数无效')
        return await self._submit('sync',id,target['profile'],input)
    async def submit_studio(self,input):
        required=('runId','taskId','profile','apiBase','token','startedAt')
        if not all(k in input for k in required) or not valid_uuid(input['runId']) or not valid_uuid(input['taskId']) or not valid_profile(input['profile']) or not isinstance(input['token'],str) or len(input['token'])<32: raise ValueError('执行任务参数无效')
        try: datetime.fromisoformat(input['startedAt'].replace('Z','+00:00'))
        except (ValueError,TypeError): raise ValueError('执行任务参数无效')
        if not self.allowed_base or input['apiBase']!=self.allowed_base: raise ValueError('执行设备回传地址与配对配置不一致')
        return await self._submit('studio',input['runId'],input['profile'],input)
    async def _submit(self,kind,id,profile,input):
        async with self.state_lock:
            existing=self.get(kind,id)
            if existing is not None: return existing
            if self.closed: raise ValueError('执行设备正在停止')
            if profile in self.profile_jobs: raise ValueError('此账号已有浏览器任务')
            if len(self.pending)>=self.max_pending: raise ValueError('执行设备草稿队列已满，请等待当前任务完成')
            ExecutionGuard(self.root,profile).check()
            state=dict(status='queued',stage='starting',message='正在等待此电脑上的浏览器任务完成',profile=profile,stopConfirmed=False,queuePosition=len(self.pending)+1)
            if kind=='studio': state.update({k:input[k] for k in ('runId','taskId','startedAt')})
            else: atomic_json(self.root/'sync-jobs'/id/'input.json',input)
            atomic_json(self.path(kind,id),state); self.pending.append((kind,id,profile,input)); self.profile_jobs[profile]=id
            self.changed.set()
            if self.worker is None or self.worker.done(): self.worker=asyncio.create_task(self._pump())
            return state
    async def progress(self,kind,id,patch):
        old=read_json(self.path(kind,id),{})
        if old.get('status') in ('stopping','cancelled','blocked') and patch.get('stopConfirmed') is not True: return old
        old.update(patch); atomic_json(self.path(kind,id),old); return old
    async def checkpoint(self,id,snapshot): atomic_json(self.root/'sync-jobs'/id/'result.json',snapshot)
    async def _execute(self,kind,id,profile,input):
        executor=self.sync_executor if kind=='sync' else self.studio_executor
        if executor is None: raise ValueError('浏览器执行环境未配置')
        async def progress(patch): return await self.progress(kind,id,patch)
        timeout=17*60 if kind=='sync' else 11*60-(self.now()-datetime.fromisoformat(input['startedAt'].replace('Z','+00:00')).timestamp())
        if timeout<=0: raise ValueError('草稿排队超时，未开始上传，请稍后重试')
        guard=ExecutionGuard(self.root,profile)
        async def watch_lease():
            while True:
                guard.check(); await asyncio.sleep(1)
        watchdog=asyncio.create_task(watch_lease()); execution=asyncio.create_task(executor({**input,'_jobId':id} if kind=='sync' else input,progress))
        try:
            done,_=await asyncio.wait((execution,watchdog),timeout=timeout,return_when=asyncio.FIRST_COMPLETED)
            if not done:
                if kind=='sync':raise ValueError('同步达到本次时间上限，已读取内容保留，请再次同步继续补全')
                raise ResultUnknown('执行超时，原稿已保留，请核对草稿，勿重复上传')
            if watchdog in done: await watchdog
            result=await execution
            if kind=='sync' and result is not None: await self.checkpoint(id,result)
            return result
        finally:
            execution.cancel(); watchdog.cancel(); await asyncio.gather(execution,watchdog,return_exceptions=True)
    async def _pump(self):
        while self.pending or self.active:
            self.changed.clear()
            if self.pending and not self.closed:
                await self.login_released.wait()
                while self.pending and len(self.active)<2 and not self.closed:
                    item=self.pending.popleft();kind,id,profile,input=item
                    task=asyncio.create_task(self._run_one(kind,id,profile,input))
                    self.active[(kind,id)]=(item,task)
            if self.pending or self.active:await self.changed.wait()

    async def _run_one(self,kind,id,profile,input):
        try:
            await self.progress(kind,id,dict(status='running',message='执行设备正在核对账号',queuePosition=0))
            await self._execute(kind,id,profile,input)
            await self.progress(kind,id,dict(status='complete',stage='finished',stopConfirmed=True,finishedAt=timestamp(),message='执行设备任务已完成',retrySafe=False))
        except asyncio.CancelledError:
            await self.progress(kind,id,dict(status='cancelled',stage='blocked',stopConfirmed=True,retrySafe=False,finishedAt=timestamp(),message='停止已确认；原页面已保留，请核对草稿，勿重复上传'))
        except Exception as exc:
            state=read_json(self.path(kind,id),{})
            await self.progress(kind,id,dict(status='blocked',stage='blocked',stopConfirmed=True,retrySafe=not state.get('uploadAttempted',False) and not isinstance(exc,ResultUnknown),finishedAt=timestamp(),message=safe_execution_error(exc).split('\n')[0][:500]))
        finally:
            self.profile_jobs.pop(profile,None); self.active.pop((kind,id),None); self.changed.set()
    async def cancel(self,kind,id):
        state=self.get(kind,id)
        if state is None: return None
        for item in list(self.pending):
            if item[:2]==(kind,id):
                self.pending.remove(item); self.profile_jobs.pop(item[2],None)
                self.changed.set()
                return await self.progress(kind,id,dict(status='cancelled',message='排队任务已移除',stopConfirmed=True))
        if (kind,id) in self.active:
            state=await self.progress(kind,id,dict(status='stopping',message='停止尚未确认，请勿重复保存草稿',stopConfirmed=False))
            self.active[(kind,id)][1].cancel()
        return state
    async def wait_idle(self):
        if self.worker: await asyncio.gather(self.worker,return_exceptions=True)
    async def close(self):
        self.closed=True
        if self.login_owner: self.release_login(self.login_owner)
        for item in list(self.pending): await self.cancel(item[0],item[1])
        for kind,id in list(self.active):await self.cancel(kind,id)
        self.changed.set()
        await self.wait_idle()
    def media_path(self,id,asset_id):
        snapshot=read_json(self.root/'sync-jobs'/id/'result.json',{})
        asset=next((a for n in snapshot.get('notes',[]) for a in n.get('mediaAssets',[]) if a.get('id')==asset_id),None)
        if asset is None: raise FileNotFoundError('媒体不属于此任务')
        return safe_file(self.root/'sync-media',asset['path'])
