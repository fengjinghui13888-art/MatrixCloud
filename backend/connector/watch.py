"""Passive observation and durable, identity-scoped event replay."""
from __future__ import annotations
import asyncio
import base64
import json
import re
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from app.protocols import valid_xhs_event,valid_xhs_subscriptions
from .files import read_json,atomic_json,fingerprint,canonical_json

def endpoint(url):
    try: u=urlsplit(url)
    except (ValueError,TypeError): return None
    if u.scheme!='https' or u.hostname not in ('creator.xiaohongshu.com','www.xiaohongshu.com','xiaohongshu.com','edith.xiaohongshu.com'): return None
    if re.search(r'/note/user/posted$',u.path): return 'notes'
    if re.search(r'/comment/(?:page|sub/page)$|/you/mentions$',u.path): return 'comments'
    if re.search(r'/messages/history$',u.path): return 'messages'

def identifier(v):
    if isinstance(v,str) and 0<len(v)<=300: return v
    if isinstance(v,int) and not isinstance(v,bool) and 0<=v<2**53: return str(v)

def ids_for(kind,body,url):
    if not isinstance(body,dict): return []
    data=body.get('data',body)
    if not isinstance(data,dict): return []
    ids=[]
    if kind=='notes': ids=[identifier(n.get('note_id',n.get('noteId',n.get('id')))) for n in data.get('notes',[]) if isinstance(n,dict)]
    elif kind=='comments':
        if urlsplit(url).path.endswith('/you/mentions'):
            ids=[identifier(n.get('comment_info',{}).get('id',n.get('comment_info',{}).get('comment_id'))) for n in data.get('mentions',data.get('message_list',data.get('items',[]))) if isinstance(n,dict)]
        else:
            def append(comments,depth=0):
                if depth>5 or not isinstance(comments,list): return
                for c in comments:
                    if not isinstance(c,dict): continue
                    ids.append(identifier(c.get('comment_id',c.get('commentId',c.get('id'))))); append(c.get('sub_comments',c.get('subComments')),depth+1)
            append(data.get('comments',[]))
    elif kind=='messages': ids=[identifier(m.get('message_id',m.get('messageId',m.get('msg_id',m.get('id'))))) for m in data.get('out_message_list',[]) if isinstance(m,dict) and (m.get('sender_id') or m.get('receiver_id') or m.get('conversation_id'))]
    return [id for id in ids if id is not None]

class EventOutbox:
    def __init__(self,root:Path,*,namespace='local',on_event=None,get_session=None,is_busy=None,max_pending=1000,max_seen=10000):
        if not 1<=max_pending<=10000 or not 1<=max_seen<=50000: raise ValueError('事件容量无效')
        self.root=Path(root); directory=self.root if namespace=='local' else self.root/'xhs-events'/fingerprint(namespace)
        self.file=directory/'xhs-event-outbox.json'; self.max_pending=max_pending; self.max_seen=max_seen
        self.on_event=on_event; self.get_session=get_session; self.is_busy=is_busy or (lambda profile:False)
        self.state=read_json(self.file,dict(format=2,pending=[],seen=[],identities={},bindings={}))
        if self.state.get('format') not in (1,2) or not isinstance(self.state.get('pending'),list) or not all(valid_xhs_event(e) for e in self.state['pending']) or not isinstance(self.state.get('seen'),list) or not all(isinstance(v,str) for v in self.state['seen']): raise ValueError('事件记录损坏，停止观察以保护未确认事件')
        self.state.setdefault('identities',{}); self.state.setdefault('bindings',{})
        self.seen=dict.fromkeys(self.state['seen'][-max_seen:]); self.subscriptions={}; self.sessions={}; self.requests={}; self.ws_requests={}; self.badges={}; self.closed=False
        self.lock=asyncio.Lock(); self.tasks=set(); self.generation=0
    def identity(self,sub): return fingerprint(dict(profile=sub['profile'],accountId=sub['accountId'],handle=sub['handle'])) if sub else None
    def save(self):
        self.state.update(format=2,seen=list(self.seen)); atomic_json(self.file,self.state)
    def status(self):
        paused=len(self.state['pending'])>=self.max_pending
        return dict(status='paused' if paused else 'watching',pending=len(self.state['pending']),heldPending=sum(self.subscriptions.get(e['profile'],{}).get('enabled') is False or self.state['identities'].get(e['eventId'])!=self.identity(self.subscriptions.get(e['profile'])) for e in self.state['pending']),**(dict(reason='outbox-full',message='待确认事件已满，自动观察暂停；已有事件保留，云端确认后恢复。') if paused else {}))
    async def report(self,event):
        sub=self.subscriptions.get(event['profile'])
        if not self.closed and sub and sub.get('enabled') is not False and self.state['identities'].get(event['eventId'])==self.identity(sub) and self.on_event:
            try: await self.on_event(event)
            except Exception: pass
    async def replay(self):
        for event in list(self.state['pending']): await self.report(event)
    async def emit(self,profile,kind,ids,suppressed=False):
        async with self.lock:
            sub=self.subscriptions.get(profile)
            if self.closed or not sub or sub.get('enabled') is False or len(self.state['pending'])>=self.max_pending: return
            owner=self.identity(sub); known=set(sub['known'+kind.title()])
            fresh=sorted(set(id for id in ids if id not in known and canonical_json([owner,kind,id]) not in self.seen))
            if not fresh: return
            stamp=fingerprint(dict(profile=profile,identity=owner,kind=kind,ids=fresh))
            if any(e['fingerprint']==stamp and self.state['identities'].get(e['eventId'])==owner for e in self.state['pending']): return
            for id in fresh:
                key=canonical_json([owner,kind,id]); self.seen.pop(key,None); self.seen[key]=None
            while len(self.seen)>self.max_seen: self.seen.pop(next(iter(self.seen)))
            if suppressed: self.save(); return
            event=dict(eventId=str(uuid.uuid4()),profile=profile,kind=kind,fingerprint=stamp)
            self.state['pending'].append(event); self.state['identities'][event['eventId']]=owner; self.save()
        await self.report(event)
    def ack(self,event_id):
        remaining=[e for e in self.state['pending'] if e['eventId']!=event_id]
        if self.closed or len(remaining)==len(self.state['pending']): return False
        self.state['pending']=remaining; self.state['identities'].pop(event_id,None); self.save(); return True
    async def set_subscriptions(self,items):
        if not valid_xhs_subscriptions(items): raise ValueError('事件订阅无效')
        self.generation+=1; previous=self.subscriptions; self.subscriptions={i['profile']:dict(i) for i in items}
        self.state['bindings']={p:self.identity(s) for p,s in self.subscriptions.items()}; self.save()
        for profile in list(self.sessions):
            sub=self.subscriptions.get(profile)
            if not sub or sub.get('enabled') is False or self.identity(previous.get(profile))!=self.identity(sub): await self.disconnect(profile)
        if self.get_session:
            for sub in items:
                if sub.get('enabled') is not False and sub['profile'] not in self.sessions: self.spawn(self.attach(sub['profile'],self.generation))
        await self.replay()
    def spawn(self,coro):
        task=asyncio.create_task(coro); self.tasks.add(task)
        def done(task):
            self.tasks.discard(task)
            if not task.cancelled(): task.exception()
        task.add_done_callback(done); return task
    async def attach(self,profile,generation):
        while not self.closed and generation==self.generation and self.subscriptions.get(profile,{}).get('enabled') is not False:
            try:
                session=await self.get_session(profile)
                if not session: raise ValueError('专属浏览器未启动')
                if self.closed or generation!=self.generation: await session.close(); return
                self.sessions[profile]=session
                session.on_event(lambda e:self.spawn(self.inspect(profile,session,e)))
                session.on_close(lambda:self.spawn(self.reconnect(profile,generation)))
                await session.send('Network.enable'); return
            except asyncio.CancelledError: raise
            except Exception:
                await self.disconnect(profile); await asyncio.sleep(5)
    async def reconnect(self,profile,generation):
        await self.disconnect(profile)
        if not self.closed: await self.attach(profile,generation)
    async def disconnect(self,profile):
        session=self.sessions.pop(profile,None)
        if session: await session.close()
        self.requests={k:v for k,v in self.requests.items() if v['profile']!=profile}
        self.ws_requests={k:v for k,v in self.ws_requests.items() if k[0]!=profile}
        self.badges={k:v for k,v in self.badges.items() if k[0]!=profile}
    @staticmethod
    def parse(raw):
        if not isinstance(raw,str): return raw
        if len(raw.encode())>2*1024*1024: return None
        try: return json.loads(raw)
        except ValueError: return None
    async def inspect(self,profile,session,event):
        if self.closed or self.subscriptions.get(profile,{}).get('enabled') is False: return
        p=event.get('params',{}); method=event.get('method'); target=event.get('targetId',''); key=(profile,target,p.get('requestId'))
        if method=='Network.webSocketClosed': self.ws_requests.pop(key,None); return
        if method=='Network.webSocketCreated':
            u=urlsplit(p.get('url',''))
            if u.scheme=='wss' and u.hostname in ('im.xiaohongshu.com','www.xiaohongshu.com','edith.xiaohongshu.com') and re.match(r'/(?:im|messages|ws)(?:/|$)',u.path) and len(self.ws_requests)<500: self.ws_requests[key]=u.geturl()
            return
        if method=='Runtime.executionContextsCleared' or method=='Page.frameNavigated' and not p.get('frame',{}).get('parentId'):
            self.badges={k:v for k,v in self.badges.items() if not (k[0]==profile and k[2]==target)}; return
        if len(self.state['pending'])>=self.max_pending: return
        if method=='Runtime.bindingCalled' and p.get('name')=='matrixXhsUnread':
            hint=self.parse(p.get('payload')); count=(hint or {}).get('count')
            if not isinstance(hint,dict) or hint.get('kind') not in ('comments','messages') or not isinstance(count,int) or isinstance(count,bool) or not 0<=count<=999999: return
            doc=hint.get('documentId',p.get('executionContextId','legacy'))
            if 'documentId' in hint and (not isinstance(doc,str) or len(doc)>100): return
            badge_key=(profile,hint['kind'],target); prev=self.badges.get(badge_key); self.badges[badge_key]=dict(count=count,documentId=doc)
            if self.is_busy(profile) or not prev or prev['documentId']!=doc: return
            if count>prev['count']: await self.emit(profile,hint['kind'],['unread:'+fingerprint(dict(target=target,previous=prev['count'],count=count,changeId=str(uuid.uuid4())))])
        elif method=='Network.responseReceived':
            response=p.get('response',{}); kind=endpoint(response.get('url'))
            if not kind or not 200<=response.get('status',0)<300: return
            record=dict(profile=profile,kind=kind,url=response['url'],targetId=target,suppressed=bool(self.is_busy(profile)))
            if 'body' in event: await self.emit(profile,kind,ids_for(kind,self.parse(event['body']),record['url']),record['suppressed'])
            elif len(self.requests)<500: self.requests[key]=record
        elif method=='Network.loadingFailed': self.requests.pop(key,None)
        elif method=='Network.loadingFinished':
            record=self.requests.pop(key,None)
            if not record or p.get('encodedDataLength',0)>2*1024*1024: return
            result=await session.send('Network.getResponseBody',dict(requestId=p['requestId']),target)
            if self.closed or self.sessions.get(profile) is not session: return
            raw=result.get('body',''); raw=base64.b64decode(raw).decode() if result.get('base64Encoded') else raw
            await self.emit(profile,record['kind'],ids_for(record['kind'],self.parse(raw),record['url']),record['suppressed'])
        elif method=='Network.webSocketFrameReceived' and key in self.ws_requests and p.get('response',{}).get('opcode')==1:
            body=self.parse(p['response'].get('payloadData'))
            if isinstance(body,dict) and body.get('type',body.get('event')) in ('message','new_message'):
                data=body.get('data',{}); m=data.get('message',data)
                if isinstance(m,dict) and (m.get('sender_id') or m.get('receiver_id') or m.get('conversation_id')):
                    id=identifier(m.get('message_id',m.get('messageId',m.get('msg_id',m.get('id')))))
                    if id: await self.emit(profile,'messages',[id])
    async def close(self):
        self.closed=True; self.generation+=1
        for task in list(self.tasks): task.cancel()
        await asyncio.gather(*list(self.tasks),return_exceptions=True)
        for profile in list(self.sessions): await self.disconnect(profile)
