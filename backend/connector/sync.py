"""Authenticated incremental creator notes, comments and private-message collection."""
from __future__ import annotations
import asyncio
import re
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urlsplit,parse_qs,quote,urlencode
from . import expressions as dom
from .browser import CREATOR,WEB,until,profile_lock
from .content import extract_content,needs_note_detail,verified_incremental_note_ownership
from .files import atomic_json
from .media import archive_media
from .note_listing import collect_note_pages,LIST_STATE,ADVANCE_LIST
from .safety import request_rejected

def relevant(path):
    return bool(re.match(r'^/api/galaxy/(user/info|.*note/user/posted)',path) or re.match(r'^/api/sns/web/v\d+/(user/(?:me|selfinfo)|feed|comment/|you/mentions)',path) or re.match(r'^/api/im/web/(v3/chats$|chats/group$|messages/history$)',path))

class NetworkCapture:
    def __init__(self,context,on_record,guard):
        self.context=context; self.on_record=on_record; self.guard=guard; self.pending=set(); self.evidence=[]; self.errors=[]; self.halted=None
        context.on('response',self.listener)
    def listener(self,response):
        u=urlsplit(response.url)
        if not (u.hostname=='xiaohongshu.com' or (u.hostname or '').endswith('.xiaohongshu.com')) or not relevant(u.path):return
        task=asyncio.create_task(self.read(response,u)); self.pending.add(task); task.add_done_callback(self.pending.discard)
    async def read(self,response,u):
        try:
            if request_rejected(response.status):
                self.halted=f'平台拒绝本次请求（HTTP {response.status}），已暂停后续操作，请人工核对'; self.guard.halt(self.halted,response.headers.get('retry-after'))
            if response.status!=200:raise ValueError('HTTP '+str(response.status))
            if 'json' not in response.headers.get('content-type',''):raise ValueError('接口返回非 JSON')
            body=await asyncio.wait_for(response.json(),15)
            if body.get('success') is False or body.get('code') not in (None,0):
                self.halted='平台业务请求未通过，已暂停账号：'+str(body.get('msg') or body.get('code'))[:100]; self.guard.halt(self.halted); raise ValueError(self.halted)
            self.evidence.append(dict(path=u.path,status=response.status,at=datetime.now(timezone.utc).isoformat()))
            self.on_record(dict(url=response.url,path=u.path,body=body))
        except asyncio.CancelledError:raise
        except Exception as exc:self.errors.append(dict(path=u.path,error=re.sub(r'https?://\S+','[地址省略]',str(exc))[:200]))
    def check(self):
        self.guard.check()
        if self.halted:raise ValueError(self.halted)
    async def flush(self):
        while self.pending:await asyncio.gather(*list(self.pending))
        self.check()
    async def stop(self):
        self.context.remove_listener('response',self.listener); await self.flush()

class SyncCollector:
    """Ownership filtering is independent of navigation and never trusts public feeds."""
    def __init__(self,target,known_notes=None,known_comments=None,known_messages=None,mode=None):
        self.target=target; self.known_notes=known_notes or []; self.known_comments=set(known_comments or []); self.known_messages=set(known_messages or []); self.mode=mode
        self.records=[]; self.consumed=0; self.owned={}; self.notes={}; self.comments={}; self.messages={}; self.peers={}; self.chats={}; self.creator=None; self.web=None; self.stored_ownership=set(); self.stored_ready=False
        self.previous={n['id']:n for n in self.known_notes}; self.known={n['id'] for n in self.known_notes if not needs_note_detail(n)}
    def record(self,r):
        self.records.append(r); path=r['path']; data=r['body'].get('data',{})
        if path=='/api/galaxy/user/info':self.creator=data
        if re.search(r'/user/(?:me|selfinfo)$',path):self.web=data
        if path.endswith('/note/user/posted'):
            for n in data.get('notes',[]):
                id=n.get('id',n.get('noteId',n.get('note_id')))
                if isinstance(id,str):self.owned[id]=n
    def assert_creator(self):
        if not self.creator or not self.creator.get('redId') or str(self.creator['redId'])!=str(self.target['handle']):raise ValueError('创作后台账号不一致或未登录，结果未保存')
    def assert_web(self):
        if not self.web or self.web.get('guest') is True or not self.web.get('user_id') or not self.web.get('red_id'):return False
        if str(self.web['user_id'])!=str((self.creator or {}).get('userId')) or str(self.web['red_id'])!=str(self.target['handle']):raise ValueError('网页版与创作后台账号不一致，本次结果不写入')
        return True
    def merge(self,found):
        for n in found['notes']:
            if n['id'] not in self.owned:continue
            old=self.notes.get(n['id'],{})
            self.notes[n['id']]={**old,**n,'summary':n.get('summary') or old.get('summary'),'images':n.get('images') or old.get('images',[]),'videoUrl':n.get('videoUrl') or old.get('videoUrl')}
        for c in found['comments']:
            if (c['noteId'] in self.owned or c['noteId'] in self.stored_ownership) and not (self.mode=='incremental' and c['id'] in self.known_comments):self.comments[c['id']]=c
        for m in found['messages']:
            if not (self.mode=='incremental' and m['id'] in self.known_messages):self.messages[m['id']]=m
    def consume(self):
        self.assert_creator()
        for id,n in self.owned.items():
            if id not in self.notes:
                if id in self.previous:self.notes[id]=dict(self.previous[id])
                self.merge(extract_content(n,self.target['id']))
        if not self.assert_web():return
        if not self.stored_ready:
            self.stored_ownership=verified_incremental_note_ownership(self.mode,self.target,self.known_notes,self.creator,self.web); self.stored_ready=True
        incoming=self.records[self.consumed:]
        for r in incoming:
            if r['path'].endswith('/chats'):
                for chat in r['body'].get('data',{}).get('chats',[]):
                    if str(chat.get('user_id'))!=str(self.creator['userId']):continue
                    peer=chat.get('chat_user_id')
                    if not peer:continue
                    self.chats[peer]=chat; info=chat.get('info',{}); self.peers[peer]=info.get('nickname') or info.get('user_name') or peer
        for r in incoming:
            if not re.search(r'/comment/|/you/mentions$|/messages/history$',r['path']):continue
            query=parse_qs(urlsplit(r['url']).query); context=dict(noteId=(query.get('note_id') or [None])[0],selfId=self.creator['userId'],selfName=self.target['name'],peers=self.peers)
            self.merge(extract_content(r['body'],self.target['id'],context))
        self.consumed=len(self.records)
    def snapshot(self):
        return dict(account=self.target,notes=list(self.notes.values()),comments=list(self.comments.values()),messages=sorted(self.messages.values(),key=lambda m:m['createdAt']))

class SyncExecutor:
    def __init__(self,root:Path,runtime):self.root=Path(root); self.runtime=runtime
    async def __call__(self,input,progress):
        ready=asyncio.get_running_loop().create_future();monitor=None
        worker=asyncio.create_task(self._run(input,progress,ready))
        try:
            done,_=await asyncio.wait((worker,ready),return_when=asyncio.FIRST_COMPLETED)
            if worker in done:return await worker
            monitor=asyncio.create_task(ready.result().wait_until_window_closed())
            done,_=await asyncio.wait((worker,monitor),return_when=asyncio.FIRST_COMPLETED)
            if worker in done:return await worker
            await monitor
        except Exception as error:
            if re.search(r'Target (?:page, context or browser has been closed|closed)|browser has been closed',str(error),re.I):
                raise ValueError('同步失败：小红书窗口已关闭，请点击开始同步重试；已保存的内容保留。') from error
            raise
        finally:
            worker.cancel()
            if monitor:monitor.cancel()
            await asyncio.gather(worker,*([monitor] if monitor else []),return_exceptions=True)

    async def _run(self,input,progress,ready):
        target=input['target']; profile=target['profile']; job_id=input['_jobId']; connection=None; network=None
        collector=SyncCollector(target,input.get('knownNotes'),input.get('knownComments'),input.get('knownMessages'),input.get('mode')); coverage=dict(notes='未读取',comments='未读取',messages='未读取'); detail_errors=[]
        async def checkpoint():
            collector.assert_creator(); snapshot=collector.snapshot(); atomic_json(self.root/'sync-jobs'/job_id/'result.json',snapshot); await progress(dict(checkpoint=True)); return snapshot
        async def report(stage,message):await progress(dict(stage=stage,message=message,counts=dict(notes=len(collector.notes),comments=len(collector.comments),messages=len(collector.messages))))
        try:
            async with profile_lock(self.root.parent/'studio-locks',profile,job_id):
                connection=await self.runtime.connect(profile,guard=True,open_creator=True); context=connection.context
                ready.set_result(connection)
                await connection.foreground()
                network=NetworkCapture(context,collector.record,connection.guard)
                async def route_guard(route):
                    try:network.check(); await route.continue_()
                    except Exception:await route.abort()
                await context.route('**/*',route_guard)
                async def step(page):
                    connection.page=page; await connection.check(); network.check(); await connection.pace(); network.check()
                async def navigate(page,url):
                    await step(page); await page.bring_to_front(); await page.goto(url,wait_until='domcontentloaded')
                async def drain():
                    await network.flush(); collector.consume()
                    # Persist comments/messages as each page arrives, including
                    # before cancellation or a later conversation times out.
                    await checkpoint()
                def records(pattern,note_id=None):
                    return [r for r in collector.records if re.search(pattern,r['path']) and (note_id is None or (parse_qs(urlsplit(r['url']).query).get('note_id') or [None])[0]==note_id)]
                async def wait_more(pattern,before,timeout=3.5,note_id=None):
                    # Navigation or a click may already have delivered the
                    # response; never wait the full timeout for a second copy.
                    async def read():await network.flush(); return len(records(pattern,note_id))
                    return await until(read,lambda n:n>before,timeout)
                creator=connection.page
                await report('account','正在核对账号登录'); await navigate(creator,CREATOR+'/new/home')
                async def creator_identity():
                    await network.flush()
                    if collector.creator and collector.creator.get('redId'):return collector.creator
                    identity=await connection.evaluate(dom.expression(dom.READCREATORIDENTITY))
                    if identity.get('loggedIn') and identity.get('handle') and identity.get('userId'):collector.creator=dict(redId=identity['handle'],userId=identity['userId'])
                    return collector.creator
                await until(creator_identity,lambda v:v and v.get('redId')); collector.assert_creator()
                visible_identity=await connection.evaluate(dom.expression(dom.READIDENTITY)); followers=visible_identity.get('followers') if isinstance(visible_identity,dict) else None
                await report('notes','账号已核对，正在读取完整笔记列表'); await navigate(creator,CREATOR+'/new/note-manager')
                await wait_more(r'/note/user/posted$',0,12); await drain()
                async def listing_state():
                    state=await creator.evaluate(LIST_STATE)
                    batches=records(r'/note/user/posted$')
                    totals=[]
                    for batch in batches:
                        data=batch['body'].get('data',{})
                        totals.extend(v for k,v in data.items() if k in ('total','total_count','notes_count') and type(v) is int)
                        totals.extend(t['notes_count'] for t in data.get('tags',[]) if t.get('id')=='special.note_time_desc' and type(t.get('notes_count')) is int)
                    if totals:state['total']=max([state.get('total') or 0,*totals])
                    state['batches']=[dict(count=len(b['body'].get('data',{}).get('notes',[])),page=b['body'].get('data',{}).get('page'),hasMore=b['body'].get('data',{}).get('has_more')) for b in batches]
                    return state
                async def advance_listing():
                    before=len(records(r'/note/user/posted$'))
                    await step(creator);await creator.evaluate(ADVANCE_LIST)
                    await wait_more(r'/note/user/posted$',before,6)
                async def listing_report(message):await report('notes',message)
                listing=await collect_note_pages(collector.owned,listing_state,advance_listing,drain,listing_report)
                atomic_json(self.root/'sync-jobs'/job_id/'listing.json',listing)
                coverage['notes']=f'已读取笔记列表 {len(collector.owned)}'+(f'/{listing["total"]}' if listing.get('total') else '')+' 篇；'+('已核对列表末尾' if listing['complete'] else '尚未核对列表末尾，可继续补全')
                await checkpoint()
                web=next((p for p in context.pages if p.url.startswith(WEB+'/')),None)
                if web is None:web=await context.new_page()
                await report('comments','正在核对网页版账号并读取评论通知'); collector.web=None; await navigate(web,WEB+'/notification')
                async def web_identity():
                    await network.flush()
                    if collector.web:return collector.web
                    identity=await connection.evaluate(dom.expression(dom.READWEBIDENTITY))
                    if identity.get('loggedIn'):collector.web=dict(user_id=identity['userId'],red_id=identity['redId'])
                    return collector.web
                await until(web_identity,bool); await drain(); logged_in=collector.assert_web()
                if not logged_in:coverage['comments']=coverage['messages']='网页版尚未登录，请在已打开的该账号窗口扫码后重新同步'
                else:
                    await wait_more(r'/you/mentions$',0,6); await drain()
                    complete=0
                    for id,n in list(collector.owned.items()):
                        if id in collector.known:continue
                        await report('notes',f'正在读取正文和媒体 {complete+1}/{len(collector.owned)}：{n.get("display_title") or id}')
                        try:
                            if not n.get('xsec_token'):raise ValueError('列表未返回详情凭据')
                            await navigate(web,WEB+'/explore/'+quote(id,safe='')+'?'+urlencode(dict(xsec_token=n['xsec_token'],xsec_source=n.get('xsec_source') or 'pc_creatormng')))
                            detail=await until(lambda:connection.evaluate(dom.expression(dom.READWEBNOTE,id)),bool,6)
                            if not detail:raise ValueError('网站未提供此笔记详情')
                            if str(detail.get('user',{}).get('userId'))!=str(collector.creator['userId']):raise ValueError('详情作者不匹配')
                            collector.merge(extract_content(detail,target['id'])); complete+=1; await checkpoint()
                            await wait_more(r'/comment/',0,2,id); await drain()
                            comment_count=detail.get('interactInfo',{}).get('commentCount')
                            if str(comment_count)=='0':continue
                            for i in range(30):
                                batches=records(r'/comment/',id); last=batches[-1]['body'].get('data',{}) if batches else {}
                                if last.get('has_more') is False:break
                                before=len(batches); await step(web); await web.locator('.comments-container').evaluate_all('es=>es.forEach(e=>e.scrollTop=e.scrollHeight)'); await web.mouse.wheel(0,1000)
                                after=await wait_more(r'/comment/',before,2,id); await drain(); latest=records(r'/comment/',id)
                                if input.get('mode')=='incremental' and latest and any(c['id'] in collector.known_comments for c in extract_content(latest[-1]['body'],target['id'],dict(noteId=id))['comments']):break
                                if after==before:break
                        except asyncio.CancelledError:raise
                        except Exception as exc:
                            network.check(); detail_errors.append(dict(noteId=id,error=re.sub(r'https?://\S+','[地址省略]',str(exc).split('\n')[0])))
                    coverage['notes']+=f'；已读取 {complete}/{len(collector.owned)} 篇正文与媒体详情'
                    # Finish note bodies before spending time paging through
                    # historical notifications and long message conversations.
                    await report('comments','正文已读取，正在补全评论通知历史')
                    await navigate(web,WEB+'/notification'); await drain()
                    for i in range(50):
                        batches=records(r'/you/mentions$'); last=batches[-1]['body'].get('data',{}) if batches else {}
                        if last.get('has_more') is False:break
                        before=len(batches); await step(web); await web.mouse.wheel(0,1600); after=await wait_more(r'/you/mentions$',before,2.5); await drain()
                        latest=records(r'/you/mentions$')
                        if input.get('mode')=='incremental' and latest and any(c['id'] in collector.known_comments for c in extract_content(latest[-1]['body'],target['id'])['comments']):break
                        if after==before:break
                    mentions=records(r'/you/mentions$'); reached=bool(mentions and mentions[-1]['body'].get('data',{}).get('has_more') is False)
                    coverage['comments']=f'已收录 {len(collector.comments)} 条评论；'+('通知到达末尾' if reached else '通知历史未到末尾')+'；评论回复完整性仍需逐笔核验'
                    await report('messages','正在逐个打开私信会话并读取历史消息'); before=len(records(r'/v3/chats$')); await navigate(web,WEB+'/chat'); await wait_more(r'/v3/chats$',before,6); await drain()
                    for i in range(50):
                        batches=records(r'/v3/chats$'); last=batches[-1]['body'].get('data',{}) if batches else {}; total=last.get('total')
                        if last and (last.get('next_ts')==-1 or isinstance(total,(int,float)) and len(collector.chats)>=total):break
                        before=len(batches); await step(web); await web.locator('.xhs-im-conv-list__scroll').evaluate_all('es=>es.forEach(e=>e.scrollTop=e.scrollHeight)')
                        after=await wait_more(r'/v3/chats$',before,3); await drain()
                        if after==before:break
                    opened=verified=0
                    for peer,info in list(collector.chats.items()):
                        await report('messages',f'正在读取会话 {opened+1}/{len(collector.chats)}：{collector.peers[peer]}')
                        try:
                            entry=web.locator('.xhs-im-conv-item__name').filter(has_text=collector.peers[peer]); await entry.first.wait_for(state='attached',timeout=8000); await entry.first.scroll_into_view_if_needed()
                            if await entry.count()!=1:raise ValueError('会话入口不唯一或尚未加载')
                            before=len(records(r'/messages/history$')); await step(web); await entry.click(); opened+=1; await wait_more(r'/messages/history$',before,6); await drain()
                            for i in range(50):
                                history=[m for r in records(r'/messages/history$') for m in r['body'].get('data',{}).get('out_message_list',[]) if m.get('sender_id')==peer or m.get('receiver_id')==peer]
                                if input.get('mode')=='incremental' and any(str(m.get('id') or m.get('message_id') or m.get('msg_id') or m.get('store_id')) in collector.known_messages for m in history):verified+=1; break
                                ids=[m['store_id'] for m in history if isinstance(m.get('store_id'),(int,float))]
                                if ids and min(ids)<=max(1,info.get('start_store_id') or 0):verified+=1; break
                                before=len(history); await step(web); await web.locator('.xhs-im-message-list, .xhs-im-msg-list').evaluate_all('es=>es.forEach(e=>e.scrollTop=0)'); await web.mouse.wheel(0,-1600); await asyncio.sleep(.5); await drain()
                                after=sum(m.get('sender_id')==peer or m.get('receiver_id')==peer for r in records(r'/messages/history$') for m in r['body'].get('data',{}).get('out_message_list',[]))
                                if after==before:break
                        except asyncio.CancelledError:raise
                        except Exception as exc:network.check(); detail_errors.append(dict(conversationId=peer,error=str(exc).split('\n')[0]))
                    coverage['messages']=f'已读取 {opened}/{len(collector.chats)} 个会话，{len(collector.messages)} 条消息；{verified} 个会话历史到达最早记录'
                await drain()
                collector.creator=None; await navigate(creator,CREATOR+'/new/home'); await until(creator_identity,lambda v:v and v.get('redId')); collector.assert_creator()
                if logged_in:
                    collector.web=None; await navigate(web,WEB+'/chat'); await until(web_identity,bool)
                    if not collector.assert_web():raise ValueError('同步过程中网页版登录失效，结果未保存')
                snapshot=collector.snapshot(); snapshot['account']={**target,'followers':followers if followers is not None else target.get('followers'),'lastSyncedAt':datetime.now(timezone.utc).isoformat(),'state':'connected'}
                snapshot.update(coverage=coverage,loginRequired=not logged_in,evidence=dict(creatorHandle=collector.creator['redId'],webHandle=collector.web.get('red_id') if logged_in else None,responses=network.evidence,errors=network.errors+detail_errors))
                atomic_json(self.root/'sync-jobs'/job_id/'result.json',snapshot); await report('media','内容已读取，正在保存媒体')
                try:
                    async def media_progress(p):await progress(dict(stage='media',message=f'正在保存媒体 {p["finished"]}/{p["total"]}',media=p))
                    snapshot['media']=await archive_media(notes=snapshot['notes'],account_id=target['id'],root=self.root/'sync-media',context=context,available_assets=input.get('availableAssets'),on_progress=media_progress,guard=connection.guard)
                except asyncio.CancelledError:raise
                except Exception as exc:snapshot['media']=dict(failed=1,message=str(exc).split('\n')[0])
                atomic_json(self.root/'sync-jobs'/job_id/'result.json',snapshot); return snapshot
        finally:
            if network:
                try:await network.stop()
                except Exception:pass
            if connection:
                try:await connection.context.unroute('**/*',route_guard)
                finally:await connection.close()
