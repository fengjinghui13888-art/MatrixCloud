import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {startXhsWatch,isProfileBusy} from '../../local-connector/xhs-watch.mjs';
import {observePages} from '../../local-connector/cdp.mjs';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {JSDOM} from 'jsdom';

const sub={profile:'local:one',accountId:'one',handle:'tester',knownNotes:['old'],knownComments:[],knownMessages:[]};
const response=(url,body)=>({method:'Network.responseReceived',params:{response:{url,status:200},requestId:'r-'+Math.random()},body});
function session(){const listeners=new Set();return {onEvent(fn){listeners.add(fn);return()=>listeners.delete(fn)},send:vi.fn(async()=>{}),emit(e){for(const fn of listeners)fn(e)}}}
describe('passive XHS watcher',()=>{
 it('emits once for a new note and ignores baseline/repeated responses',async()=>{const root=mkdtempSync(join(tmpdir(),'xhs-watch-')),s=session(),events=[];const watch=startXhsWatch({root,getSession:async()=>s,isBusy:()=>false,onEvent:async e=>(events.push(e),true)});watch.setSubscriptions([sub]);await new Promise(r=>setTimeout(r,0));await s.emit(response('https://www.xiaohongshu.com/api/sns/web/v1/note/user/posted',{data:{notes:[{note_id:'new-note'}]}}));await new Promise(r=>setTimeout(r,10));expect(events).toHaveLength(1);await s.emit(response('https://www.xiaohongshu.com/api/sns/web/v1/note/user/posted',{data:{notes:[{note_id:'new-note'}]}}));await new Promise(r=>setTimeout(r,10));expect(events).toHaveLength(1);watch.close();rmSync(root,{recursive:true,force:true});});
 it('does not emit while busy, ignores non-XHS and keeps failed events for reconnect retry',async()=>{const root=mkdtempSync(join(tmpdir(),'xhs-watch-')),s=session(),busy=vi.fn(()=>true),send=vi.fn(async()=>false);const watch=startXhsWatch({root,getSession:async()=>s,isBusy:busy,onEvent:send});watch.setSubscriptions([sub]);await new Promise(r=>setTimeout(r,0));await s.emit(response('https://www.xiaohongshu.com/api/sns/web/v1/note/user/posted',{data:{notes:[{note_id:'collector-note'}]}}));await s.emit(response('https://example.test/api/notes',{items:[{noteId:'other'}]}));await new Promise(r=>setTimeout(r,10));expect(send).not.toHaveBeenCalled();busy.mockReturnValue(false);await s.emit(response('https://www.xiaohongshu.com/api/sns/web/v1/note/user/posted',{data:{notes:[{note_id:'new-note'}]}}));await new Promise(r=>setTimeout(r,10));expect(send).toHaveBeenCalledTimes(1);watch.setSubscriptions([sub]);await new Promise(r=>setTimeout(r,10));expect(send).toHaveBeenCalledTimes(2);expect(JSON.parse(readFileSync(join(root,'xhs-event-outbox.json'),'utf8')).pending).toHaveLength(1);watch.ack(send.mock.calls[0][0].eventId);expect(JSON.parse(readFileSync(join(root,'xhs-event-outbox.json'),'utf8')).pending).toHaveLength(0);watch.close();rmSync(root,{recursive:true,force:true});});
 it('emits notes for the creator published-list response',async()=>{const root=mkdtempSync(join(tmpdir(),'xhs-watch-')),s=session(),events=[];const watch=startXhsWatch({root,getSession:async()=>s,onEvent:async e=>(events.push(e),true)});watch.setSubscriptions([sub]);await new Promise(r=>setTimeout(r,0));await s.emit(response('https://creator.xiaohongshu.com/api/sns/web/v1/note/user/posted',{notes:[{noteId:'creator-new'}]}));await new Promise(r=>setTimeout(r,10));expect(events.map(e=>e.kind)).toEqual(['notes']);watch.close();rmSync(root,{recursive:true,force:true});});
 });

it('reads completed responses through the real CDP adapter and retains sends until ACK',async()=>{
 const root=mkdtempSync(join(tmpdir(),'watch-cdp-')),commands=[],events=[];
 const server=createServer(),wss=new WebSocketServer({server});let browser;
 const documents=new Map(['creator','web'].map(id=>[id,new JSDOM('<a href="/message"><span class="badge">2</span></a>',{url:id==='creator'?'https://creator.xiaohongshu.com/':'https://www.xiaohongshu.com/',runScripts:'outside-only'})]));
 wss.on('connection',ws=>{browser=ws;ws.on('message',raw=>{const m=JSON.parse(raw);commands.push(m);let result={};if(m.method==='Target.getTargets')result={targetInfos:[{targetId:'creator',type:'page',url:'https://creator.xiaohongshu.com/new/home'},{targetId:'web',type:'page',url:'https://www.xiaohongshu.com/'},{targetId:'ordinary',type:'page',url:'https://example.test/'}]};if(m.method==='Target.attachToTarget')result={sessionId:m.params.targetId};if(m.method==='Network.getResponseBody')result={body:JSON.stringify({data:{notes:[{note_id:'new-note',user:{id:'wrong-user'}}]}})};const dom=documents.get(m.sessionId);if(m.method==='Runtime.addBinding'&&dom)dom.window[m.params.name]=payload=>ws.send(JSON.stringify({method:'Runtime.bindingCalled',sessionId:m.sessionId,params:{name:m.params.name,payload}}));if(m.method==='Runtime.evaluate'&&dom)dom.window.eval(m.params.expression);if(m.method==='Page.addScriptToEvaluateOnNewDocument')result={identifier:'script-'+m.sessionId};ws.send(JSON.stringify({id:m.id,result}));});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 let adapter,watch;
 try{
  adapter=await observePages(port,{browserUrl:`ws://127.0.0.1:${port}/browser`});watch=startXhsWatch({root,namespace:'https://cloud.test|device',getSession:async()=>adapter,onEvent:async e=>{events.push(e);return true;}});await watch.setSubscriptions([sub]);
  browser.send(JSON.stringify({method:'Network.responseReceived',sessionId:'creator',params:{requestId:'r1',response:{url:'https://creator.xiaohongshu.com/api/sns/web/v1/note/user/posted',status:200}}}));
  await new Promise(r=>setTimeout(r,20));expect(commands.filter(m=>m.method==='Network.getResponseBody')).toHaveLength(0);
  browser.send(JSON.stringify({method:'Network.loadingFinished',sessionId:'creator',params:{requestId:'r1'}}));await vi.waitFor(()=>expect(events).toHaveLength(1));
  expect(commands.find(m=>m.method==='Network.getResponseBody').sessionId).toBe('creator');
  await watch.setSubscriptions([sub]);expect(events).toHaveLength(2);watch.ack(events[0].eventId);await watch.setSubscriptions([sub]);expect(events).toHaveLength(2);
  expect(commands.filter(m=>m.method==='Network.enable').map(m=>m.sessionId).sort()).toEqual(['creator','web']);expect(commands.some(m=>m.method==='Target.attachToTarget'&&m.params.targetId==='ordinary')).toBe(false);
  documents.get('web').window.document.querySelector('.badge').textContent='3';await vi.waitFor(()=>expect(events).toHaveLength(3));expect(events[2].kind).toBe('messages');
  documents.get('web').window.document.body.innerHTML='';await new Promise(r=>setTimeout(r,10));documents.get('web').window.document.body.innerHTML='<a href="/message"><span class="badge">3</span></a>';await new Promise(r=>setTimeout(r,20));expect(events).toHaveLength(3);
  browser.send(JSON.stringify({method:'Target.targetCreated',params:{targetInfo:{targetId:'new-web',type:'page',url:'https://www.xiaohongshu.com/notification'}}}));await vi.waitFor(()=>expect(commands.some(m=>m.method==='Network.enable'&&m.sessionId==='new-web')).toBe(true));
  browser.send(JSON.stringify({method:'Target.targetInfoChanged',params:{targetInfo:{targetId:'new-web',type:'page',url:'https://example.test/'}}}));await vi.waitFor(()=>expect(commands.some(m=>m.method==='Target.detachFromTarget'&&m.params.sessionId==='new-web')).toBe(true));
  expect(commands.some(m=>/navigate|reload/.test(m.method))).toBe(false);
 }finally{watch?.close();await adapter?.close();for(const dom of documents.values())dom.window.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true});}
});

it('ignores feed/user IDs and scopes dedup and pending events to profile and cloud/device',async()=>{
 const root=mkdtempSync(join(tmpdir(),'watch-isolate-')),s=session(),events=[];let watch;
 try{
  watch=startXhsWatch({root,namespace:'https://a.test|device-a',getSession:async()=>s,onEvent:async e=>events.push(e)});
  await watch.setSubscriptions([sub,{...sub,profile:'local:two'}]);
  s.emit(response('https://www.xiaohongshu.com/api/sns/web/v1/homefeed',{data:{notes:[{id:'feed'}]}}));
  s.emit(response('https://evil.test/api/sns/web/v1/note/user/posted',{data:{notes:[{id:'bad'}]}}));
  s.emit(response('https://www.xiaohongshu.com/api/sns/web/v1/note/user/posted',{data:{user:{id:'user'},notes:[]}}));await new Promise(r=>setTimeout(r,10));expect(events).toHaveLength(0);
  s.emit(response('https://creator.xiaohongshu.com/api/sns/web/v1/note/user/posted',{data:{notes:[{note_id:'same-note',user:{id:'user'}}]}}));await vi.waitFor(()=>expect(events).toHaveLength(2));expect(new Set(events.map(e=>e.fingerprint)).size).toBe(2);
  const first=events[0];watch.close();watch=startXhsWatch({root,namespace:'https://b.test|device-b',getSession:async()=>s,onEvent:async e=>events.push(e)});await watch.setSubscriptions([sub]);expect(events).toHaveLength(2);watch.close();
  watch=startXhsWatch({root,namespace:'https://a.test|device-a',getSession:async()=>s,onEvent:async e=>events.push(e)});await watch.setSubscriptions([sub]);expect(events.at(-1).eventId).toBe(first.eventId);watch.ack(first.eventId);watch.close();
  watch=startXhsWatch({root,namespace:'https://a.test|device-a',getSession:async()=>s,onEvent:async e=>events.push(e)});await watch.setSubscriptions([sub]);const n=events.length;s.emit(response('https://creator.xiaohongshu.com/api/sns/web/v1/note/user/posted',{data:{notes:[{note_id:'same-note'}]}}));await new Promise(r=>setTimeout(r,10));expect(events).toHaveLength(n);
 }finally{watch?.close();rmSync(root,{recursive:true,force:true});}
});

it('captures busy HTTP responses before loading finishes while retaining real inbound IM hints',async()=>{
 const root=mkdtempSync(join(tmpdir(),'watch-busy-')),s=session(),events=[];let busy=true;
 s.send.mockImplementation(async method=>method==='Network.getResponseBody'?{body:JSON.stringify({data:{comments:[{comment_id:'self-collection',user_info:{id:'wrong-user'}}]}})}:{});
 const watch=startXhsWatch({root,getSession:async()=>s,isBusy:()=>busy,onEvent:async e=>events.push(e)});
 try{await watch.setSubscriptions([sub]);s.emit({method:'Network.responseReceived',targetId:'web',params:{requestId:'http',response:{url:'https://edith.xiaohongshu.com/api/sns/web/v2/comment/page',status:200}}});busy=false;s.emit({method:'Network.loadingFinished',targetId:'web',params:{requestId:'http'}});await new Promise(r=>setTimeout(r,10));expect(events).toHaveLength(0);
  s.emit(response('https://edith.xiaohongshu.com/api/sns/web/v2/comment/page',{data:{comments:[{comment_id:'self-collection'}]}}));await new Promise(r=>setTimeout(r,10));expect(events).toHaveLength(0);
  busy=true;s.emit({method:'Network.webSocketCreated',targetId:'web',params:{requestId:'im',url:'wss://im.xiaohongshu.com/im/connect'}});s.emit({method:'Network.webSocketFrameReceived',targetId:'web',params:{requestId:'im',response:{opcode:1,payloadData:JSON.stringify({type:'new_message',data:{message_id:'inbound',sender_id:'peer',receiver_id:'self'}})}}});await vi.waitFor(()=>expect(events).toHaveLength(1));expect(events[0].kind).toBe('messages');
 }finally{watch.close();rmSync(root,{recursive:true,force:true});}
});

it('uses only changes in unread notification bindings, without treating the initial badge as new',async()=>{
 const root=mkdtempSync(join(tmpdir(),'watch-unread-')),s=session(),events=[];const watch=startXhsWatch({root,getSession:async()=>s,onEvent:async e=>events.push(e)});
 try{await watch.setSubscriptions([sub]);const badge=count=>({method:'Runtime.bindingCalled',targetId:'web',params:{name:'matrixXhsUnread',payload:JSON.stringify({kind:'messages',count})}});
  s.emit(badge(2));s.emit(badge(2));await new Promise(r=>setTimeout(r,10));expect(events).toHaveLength(0);s.emit(badge(3));await vi.waitFor(()=>expect(events).toHaveLength(1));s.emit(badge(0));s.emit(badge(0));await new Promise(r=>setTimeout(r,10));expect(events).toHaveLength(1);
 }finally{watch.close();rmSync(root,{recursive:true,force:true});}
});

it('never creates DOM hints from busy own navigation or hydration and rebaselines each document',async()=>{
 const root=mkdtempSync(join(tmpdir(),'watch-hydration-')),s=session(),events=[];let busy=true;
 const watch=startXhsWatch({root,getSession:async()=>s,isBusy:()=>busy,onEvent:async e=>events.push(e)});
 try{await watch.setSubscriptions([sub]);const badge=(count,documentId)=>s.emit({method:'Runtime.bindingCalled',targetId:'web',params:{name:'matrixXhsUnread',payload:JSON.stringify({kind:'messages',count,documentId})}});
  for(const id of ['doc-1','doc-2','doc-3']){s.emit({method:'Page.frameNavigated',targetId:'web',params:{frame:{id:'main'}}});badge(0,id);badge(4,id);}await new Promise(r=>setTimeout(r,20));expect(events).toHaveLength(0);
  busy=false;s.emit({method:'Page.frameNavigated',targetId:'web',params:{frame:{id:'main'}}});badge(4,'doc-4');await new Promise(r=>setTimeout(r,10));expect(events).toHaveLength(0);badge(5,'doc-4');await vi.waitFor(()=>expect(events).toHaveLength(1));
 }finally{await watch.close();rmSync(root,{recursive:true,force:true});}
});

it('bounds recent dedup, pauses a full outbox explicitly and never discards pending ACKs',async()=>{
 const root=mkdtempSync(join(tmpdir(),'watch-limit-')),s=session(),events=[],statuses=[];
 const watch=startXhsWatch({root,maxPending:2,maxSeen:3,getSession:async()=>s,onStatus:s=>statuses.push(s),onEvent:async e=>events.push(e)});
 try{await watch.setSubscriptions([sub]);const note=id=>s.emit(response('https://creator.xiaohongshu.com/api/sns/web/v1/note/user/posted',{data:{notes:[{note_id:id}]}}));
  note('1');note('2');note('3');await vi.waitFor(()=>expect(events).toHaveLength(2));expect(statuses.some(s=>s.status==='paused'&&s.reason==='outbox-full')).toBe(true);
  const saved=()=>JSON.parse(readFileSync(join(root,'xhs-event-outbox.json'),'utf8'));expect(saved().pending.map(e=>e.eventId)).toEqual(events.map(e=>e.eventId));watch.ack(events[0].eventId);note('3');await vi.waitFor(()=>expect(events).toHaveLength(3));watch.ack(events[1].eventId);watch.ack(events[2].eventId);
  for(const id of ['4','5','6','7']){note(id);await new Promise(r=>setTimeout(r,5));watch.ack(events.at(-1).eventId);}expect(saved().seen.length).toBeLessThanOrEqual(3);
 }finally{watch.close();rmSync(root,{recursive:true,force:true});}
});

it('persists event subscription identity and never replays old pending hints after a rebind',async()=>{
 const root=mkdtempSync(join(tmpdir(),'watch-rebind-')),s=session(),events=[];let watch;
 const create=()=>startXhsWatch({root,getSession:async()=>s,onEvent:async e=>events.push(e)});
 try{watch=create();await watch.setSubscriptions([sub]);s.emit(response('https://creator.xiaohongshu.com/api/sns/web/v1/note/user/posted',{data:{notes:[{note_id:'old-account-note'}]}}));await vi.waitFor(()=>expect(events).toHaveLength(1));const original=events[0];
  await watch.setSubscriptions([{...sub,accountId:'different',handle:'new-handle'}]);expect(events).toHaveLength(1);watch.close();watch=create();await watch.setSubscriptions([{...sub,accountId:'different',handle:'new-handle'}]);expect(events).toHaveLength(1);
  await watch.setSubscriptions([{...sub,enabled:false}]);expect(events).toHaveLength(1);await watch.setSubscriptions([sub]);expect(events.at(-1).eventId).toBe(original.eventId);watch.ack(original.eventId);
 }finally{watch?.close();rmSync(root,{recursive:true,force:true});}
});

it('suppresses only the executing account and retains another profile HTTP hint',async()=>{
 const root=mkdtempSync(join(tmpdir(),'watch-account-busy-')),id='11111111-1111-4111-8111-111111111111',a=session(),b=session(),events=[];
 mkdirSync(join(root,'sync-jobs',id),{recursive:true});writeFileSync(join(root,'sync-jobs',id,'input.json'),JSON.stringify({target:{profile:'local:one'}}));
 const watch=startXhsWatch({root,getSession:async profile=>profile==='local:one'?a:b,isBusy:profile=>isProfileBusy({root,profile,activeIds:[id],loginIds:[]}),onEvent:async e=>events.push(e)});
 try{await watch.setSubscriptions([sub,{...sub,profile:'local:two',accountId:'two'}]);const payload=response('https://creator.xiaohongshu.com/api/sns/web/v1/note/user/posted',{data:{notes:[{id:'new'}]}});a.emit(payload);b.emit(payload);await vi.waitFor(()=>expect(events).toHaveLength(1));expect(events[0].profile).toBe('local:two');
 }finally{await watch.close();rmSync(root,{recursive:true,force:true});}
});

it('awaits the old observer cleanup before attaching a replacement and resolves close afterward',async()=>{
 const root=mkdtempSync(join(tmpdir(),'watch-cleanup-order-')),old=session(),next=session(),steps=[];let release;
 old.close=()=>new Promise(resolve=>{steps.push('cleanup-start');release=()=>{steps.push('cleanup-end');resolve();};});next.close=async()=>steps.push('new-cleanup');
 const watch=startXhsWatch({root,getSession:async profile=>{steps.push('attach-'+profile);return profile==='local:one'?old:next;}});
 try{await watch.setSubscriptions([sub]);const replacement=watch.setSubscriptions([{...sub,profile:'local:two',accountId:'two'}]);await new Promise(r=>setTimeout(r,10));expect(steps).toEqual(['attach-local:one','cleanup-start']);release();await replacement;expect(steps).toEqual(['attach-local:one','cleanup-start','cleanup-end','attach-local:two']);await watch.close();expect(steps.at(-1)).toBe('new-cleanup');
 }finally{release?.();await watch.close();rmSync(root,{recursive:true,force:true});}
});

it('waits for an in-flight CDP attachment cleanup before close completes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'watch-close-inflight-')),s=session();let resolveSession,resolveCleanup,closed=false;
 s.close=()=>new Promise(resolve=>{resolveCleanup=resolve;});const watch=startXhsWatch({root,getSession:()=>new Promise(resolve=>{resolveSession=resolve;})});
 try{const setting=watch.setSubscriptions([sub]);await vi.waitFor(()=>expect(resolveSession).toBeTypeOf('function'));const closing=watch.close().then(()=>closed=true);resolveSession(s);await vi.waitFor(()=>expect(resolveCleanup).toBeTypeOf('function'));expect(closed).toBe(false);resolveCleanup();await closing;await setting;expect(closed).toBe(true);
 }finally{resolveSession?.(s);resolveCleanup?.();await watch.close();rmSync(root,{recursive:true,force:true});}
});



