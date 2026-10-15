from __future__ import annotations
import asyncio
import hashlib
import random
import re
import time
from datetime import datetime
from pathlib import Path
from .files import atomic_json, read_json

class ResultUnknown(RuntimeError):
    code='SCRIPT_TIMEOUT'

def request_rejected(status):
    # A missing asset is common; other client errors need manual review rather
    # than automatic retries. This is a stop signal, not proof of an account ban.
    return isinstance(status,int) and 400<=status<500 and status!=404

def safe_execution_error(error):
    text=re.sub(r'\x1b\[[0-9;]*m','',str(error) or '未知错误')
    text=re.sub(r'[A-Za-z0-9+/=]{160,}','[大段传输内容已省略]',text)
    return re.sub(r'https?://\S+','[地址省略]',text)[:1200]

class ExecutionGuard:
    def __init__(self,root:Path,profile:str,*,now=None,epoch:str=''):
        self.root=Path(root); self.profile=profile; self.now=now or (lambda:time.time()*1000); self.epoch=epoch
        self.path=self.root/'account-safety'/(hashlib.sha256(profile.encode()).hexdigest()+'.json')
    def status(self): return read_json(self.path,{'state':'normal'})
    def check(self):
        lease=read_json(self.root/'device-lease.json')
        if lease is not None and (not isinstance(lease,dict) or not isinstance(lease.get('until'),(int,float)) or lease['until']<self.now() or self.epoch and lease.get('epoch')!=self.epoch):
            raise ValueError('执行器连接租约已失效，已停止后续操作')
        if self.status().get('state')!='normal': raise ValueError('账号已暂停自动操作，请人工核对平台提示后恢复')
    def halt(self,reason,retry_after=None):
        until=None
        if isinstance(retry_after,str):
            try: until=self.now()+int(retry_after)*1000 if retry_after.isdigit() else datetime.fromisoformat(retry_after.replace('Z','+00:00')).timestamp()*1000
            except ValueError: pass
        atomic_json(self.path,dict(state='cooldown' if until is not None else 'paused',until=until,reason=str(reason)[:300],at=self.now()))
    def resume(self,confirmed):
        if confirmed is not True: raise ValueError('需要人工核对')
        until=self.status().get('until')
        if until and until>self.now(): raise ValueError('平台等待时间尚未结束')
        atomic_json(self.path,dict(state='normal',at=self.now()))

class ActionPacer:
    def __init__(self,interval=5.0,jitter=2.0,*,wait=asyncio.sleep,random_fn=random.random):
        self.interval=interval; self.jitter=jitter; self.wait=wait; self.random=random_fn
    async def __call__(self): await self.wait(self.interval+self.random()*self.jitter)
