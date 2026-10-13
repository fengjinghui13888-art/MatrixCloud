import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {validXhsEvent,validXhsSubscriptions} from '../shared/xhs-events.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier=v=>typeof v==='string'&&v.length>0&&v.length<=300?v:Number.isSafeInteger(v)&&v>=0?String(v):null;
const list=v=>Array.isArray(v)?v:[];
const key=(profile,kind,id)=>JSON.stringify([profile,kind,id]);
function endpoint(url){
 let u;try{u=new URL(url);}catch{return null;}
 if(u.protocol!=='https:'||!['creator.xiaohongshu.com','www.xiaohongshu.com','xiaohongshu.com','edith.xiaohongshu.com'].includes(u.hostname))return null;
 if(/\/note\/user\/posted$/.test(u.pathname))return 'notes';
 if(/\/comment\/(?:page|sub\/page)$/.test(u.pathname)||/\/you\/mentions$/.test(u.pathname))return 'comments';
 if(/\/messages\/history$/.test(u.pathname))return 'messages';return null;
}
function idsFor(kind,body,url){
 const data=body?.data??body;
 if(kind==='notes')return list(data?.notes).map(n=>identifier(n?.note_id??n?.noteId??n?.id)).filter(Boolean);
 if(kind==='comments'){
  if(/\/you\/mentions$/.test(new URL(url).pathname))return list(data?.mentions??data?.message_list??data?.items).map(n=>identifier(n?.comment_info?.id??n?.comment_info?.comment_id)).filter(Boolean);
  const ids=[];const append=(comments,depth=0)=>{if(depth>5)return;for(const c of list(comments)){const id=identifier(c?.comment_id??c?.commentId??c?.id);if(id)ids.push(id);append(c?.sub_comments??c?.subComments,depth+1);}};append(data?.comments);return ids;
 }
 return list(data?.out_message_list).filter(m=>m&&(m.sender_id||m.receiver_id||m.conversation_id)).map(m=>identifier(m.message_id??m.messageId??m.msg_id??m.id)).filter(Boolean);
}
function pushedMessage(body){
 if(!['message','new_message'].includes(body?.type??body?.event))return [];
 const m=body.data?.message??body.data;if(!m||!(m.sender_id||m.receiver_id||m.conversation_id))return [];
 return [identifier(m.message_id??m.messageId??m.msg_id??m.id)].filter(Boolean);
}
function imSocket(url){try{const u=new URL(url);return u.protocol==='wss:'&&['im.xiaohongshu.com','www.xiaohongshu.com','edith.xiaohongshu.com'].includes(u.hostname)&&/^\/(?:im|messages|ws)(?:\/|$)/.test(u.pathname);}catch{return false;}}
export function isProfileBusy({root,profile,activeIds=[],loginIds=[]}={}){
 if(!/^local:[\w-]{1,100}$/.test(profile||''))return false;
 if(loginIds.includes(profile.slice(6))||activeIds.includes('login:'+profile.slice(6)))return true;
 for(const id of activeIds){if(!/^[a-f0-9-]{36}$/i.test(id))continue;
  for(const file of [join(root,'sync-jobs',id,'input.json'),join(root,'studio-jobs',id+'.json')])try{const task=JSON.parse(readFileSync(file,'utf8'));if((task.target?.profile??task.profile)===profile)return true;}catch{}
 }return false;
}
export function startXhsWatch({root,namespace='local',getSession,isBusy=()=>false,onEvent=async()=>{},onStatus=()=>{},reconnectMs=5000,maxPending=1000,maxSeen=10000}={}){
 if(typeof root!=='string'||typeof getSession!=='function'||typeof onEvent!=='function')throw Error('观察器参数无效');
 const dir=namespace==='local'?root:join(root,'xhs-events',hash(namespace));mkdirSync(dir,{recursive:true,mode:0o700});const file=join(dir,'xhs-event-outbox.json');
 if(!Number.isInteger(maxPending)||maxPending<1||maxPending>10000||!Number.isInteger(maxSeen)||maxSeen<1||maxSeen>50000)throw Error('事件容量无效');
 let state={pending:[],seen:[],identities:{},bindings:{}};try{const saved=JSON.parse(readFileSync(file,'utf8'));if(![1,2].includes(saved?.format)||!Array.isArray(saved.pending)||!saved.pending.every(validXhsEvent)||!Array.isArray(saved.seen)||!saved.seen.every(v=>typeof v==='string'))throw Error('invalid state');state={pending:saved.pending,seen:saved.seen.slice(-maxSeen),identities:saved.identities??{},bindings:saved.bindings??{}};}catch(error){if(error.code!=='ENOENT')throw Error('事件记录损坏，停止观察以保护未确认事件');}
 const seen=new Set(state.seen),subscriptions=new Map(),sessions=new Map(),retryTimers=new Map(),requests=new Map(),wsRequests=new Map(),badges=new Map(),attachmentTasks=new Set(),cleanupTasks=new Set();let closed=false,generation=0,closing,subscriptionChain=Promise.resolve();
 const identity=sub=>sub?hash({profile:sub.profile,accountId:sub.accountId,handle:sub.handle}):null;
 let paused=state.pending.length>=maxPending;
 const status=()=>({status:paused?'paused':'watching',...(paused?{reason:'outbox-full',message:'待确认事件已满，自动观察暂停；已有事件保留，云端确认后恢复。'}:{}),pending:state.pending.length,heldPending:state.pending.filter(e=>subscriptions.get(e.profile)?.enabled===false||state.identities[e.eventId]!==identity(subscriptions.get(e.profile))).length});
 const notify=()=>{try{onStatus(status());}catch{}};
 const updateCapacity=()=>{const next=state.pending.length>=maxPending;if(next!==paused){paused=next;if(paused)requests.clear();notify();}};
 const remember=values=>{for(const value of values){seen.delete(value);seen.add(value);}while(seen.size>maxSeen)seen.delete(seen.values().next().value);};
 const save=()=>{const temporary=file+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify({format:2,pending:state.pending,seen:[...seen],identities:state.identities,bindings:state.bindings}),{mode:0o600,flush:true});renameSync(temporary,file);};
 const report=async event=>{const sub=subscriptions.get(event.profile);if(!closed&&sub?.enabled!==false&&state.identities[event.eventId]===identity(sub))try{await onEvent(event);}catch{/* Keep until authenticated cloud ACK. */}};
 const emit=async(profile,kind,ids,suppressed=false)=>{
  const sub=subscriptions.get(profile);if(closed||!sub||sub.enabled===false||paused)return;
  const owner=identity(sub),known=new Set(sub['known'+kind[0].toUpperCase()+kind.slice(1)]),fresh=[...new Set(ids)].filter(id=>!known.has(id)&&!seen.has(key(owner,kind,id))).sort();if(!fresh.length)return;
  const fingerprint=hash({profile,identity:owner,kind,ids:fresh});if(state.pending.some(e=>e.fingerprint===fingerprint&&state.identities[e.eventId]===owner))return;
  remember(fresh.map(id=>key(owner,kind,id)));if(suppressed){save();return;}
  const event={eventId:randomUUID(),profile,kind,fingerprint};state.pending.push(event);state.identities[event.eventId]=owner;save();updateCapacity();await report(event);
 };
 const parse=raw=>{if(typeof raw!=='string')return raw;if(Buffer.byteLength(raw)>2*1024*1024)return null;try{return JSON.parse(raw);}catch{return null;}};
 const inspect=async(profile,session,e)=>{
  if(closed||subscriptions.get(profile)?.enabled===false)return;const p=e.params??{},requestKey=JSON.stringify([profile,e.targetId??'',p.requestId]);
  if(e.method==='Network.webSocketClosed'){wsRequests.delete(requestKey);return;}
  if(e.method==='Network.webSocketCreated'){if(imSocket(p.url)&&wsRequests.size<500)wsRequests.set(requestKey,p.url);return;}
  if(e.method==='Runtime.executionContextsCleared'||e.method==='Page.frameNavigated'&&!p.frame?.parentId){for(const k of badges.keys()){const [owner,,target]=JSON.parse(k);if(owner===profile&&target===(e.targetId??''))badges.delete(k);}return;}
  if(paused)return;
  if(e.method==='Runtime.bindingCalled'&&p.name==='matrixXhsUnread'){
   const hint=parse(p.payload);if(!hint||!['comments','messages'].includes(hint.kind)||!Number.isInteger(hint.count)||hint.count<0||hint.count>999999)return;
   if(hint.documentId!==undefined&&(typeof hint.documentId!=='string'||hint.documentId.length>100))return;
   const badgeKey=key(profile,hint.kind,e.targetId??''),documentId=hint.documentId??p.executionContextId??'legacy',previous=badges.get(badgeKey);badges.set(badgeKey,{count:hint.count,documentId});
   // Busy DOM hints are baseline-only, not durable dedup: navigation and
   // hydration cannot start another collection. Typed inbound IM is separate.
   if(isBusy(profile)||!previous||previous.documentId!==documentId)return;
   if(hint.count>previous.count)await emit(profile,hint.kind,['unread:'+hash({target:e.targetId,previous:previous.count,count:hint.count,changeId:randomUUID()})]);return;
  }
  if(e.method==='Network.responseReceived'){
   const kind=endpoint(p.response?.url);if(!kind||p.response.status<200||p.response.status>=300)return;
   const record={profile,kind,url:p.response.url,targetId:e.targetId,suppressed:!!isBusy(profile)};
   if(e.body!==undefined){await emit(profile,kind,idsFor(kind,parse(e.body),record.url),record.suppressed);return;}
   if(requests.size<500)requests.set(requestKey,record);return;
  }
  if(e.method==='Network.loadingFailed'){requests.delete(requestKey);return;}
  if(e.method==='Network.loadingFinished'){
   const record=requests.get(requestKey);requests.delete(requestKey);if(!record||p.encodedDataLength>2*1024*1024)return;
   const result=await session.send('Network.getResponseBody',{requestId:p.requestId},record.targetId);if(closed||sessions.get(profile)?.session!==session)return;
   const raw=result?.base64Encoded?Buffer.from(result.body,'base64').toString('utf8'):result?.body;await emit(profile,record.kind,idsFor(record.kind,parse(raw),record.url),record.suppressed);return;
  }
  // Inbound IM hints survive busy syncs; HTTP collector traffic is suppressed.
  if(e.method==='Network.webSocketFrameReceived'&&wsRequests.has(requestKey)&&p.response?.opcode===1)await emit(profile,'messages',pushedMessage(parse(p.response.payloadData)));
 };
 const disconnect=profile=>{const entry=sessions.get(profile);sessions.delete(profile);entry?.off?.();entry?.offClose?.();const task=Promise.resolve().then(()=>entry?.session.close?.());cleanupTasks.add(task);void task.finally(()=>cleanupTasks.delete(task)).catch(()=>{});for(const [k,r]of requests)if(r.profile===profile)requests.delete(k);for(const k of wsRequests.keys())if(JSON.parse(k)[0]===profile)wsRequests.delete(k);return task;};
 const schedule=(profile,epoch)=>{if(closed||epoch!==generation||retryTimers.has(profile)||subscriptions.get(profile)?.enabled===false)return;const timer=setTimeout(()=>{retryTimers.delete(profile);void launchAttach(profile,epoch);},reconnectMs);timer.unref?.();retryTimers.set(profile,timer);};
 const attach=async(profile,epoch)=>{
  if(closed||epoch!==generation||subscriptions.get(profile)?.enabled===false||sessions.has(profile))return;let session;
  try{session=await getSession(profile);if(!session)throw Error('专属浏览器未启动');if(closed||epoch!==generation){await session.close?.();return;}
   if(typeof session.send!=='function'||typeof session.onEvent!=='function')throw Error('被动 CDP 接口无效');
   const entry={session,off:session.onEvent(e=>{void inspect(profile,session,e).catch(()=>{});})};sessions.set(profile,entry);
   entry.offClose=session.onClose?.(()=>{if(sessions.get(profile)?.session!==session)return;void disconnect(profile).finally(()=>schedule(profile,generation)).catch(()=>{});});await session.send('Network.enable');
  }catch{if(sessions.get(profile)?.session===session)await disconnect(profile).catch(()=>{});else await session?.close?.();schedule(profile,epoch);}
 };
 const launchAttach=(profile,epoch)=>{const task=attach(profile,epoch);attachmentTasks.add(task);void task.finally(()=>attachmentTasks.delete(task)).catch(()=>{});return task;};
 const replay=async()=>{for(const e of [...state.pending])await report(e);};
 const setSubscriptions=items=>{if(!validXhsSubscriptions(items))return Promise.reject(Error('事件订阅无效'));const task=subscriptionChain.then(async()=>{if(closed)return;generation++;for(const timer of retryTimers.values())clearTimeout(timer);retryTimers.clear();const previous=new Map(subscriptions);subscriptions.clear();state.bindings={};for(const item of items){subscriptions.set(item.profile,{...item});state.bindings[item.profile]=identity(item);}const cleanups=[];for(const profile of [...sessions.keys()])if(!subscriptions.has(profile)||subscriptions.get(profile).enabled===false||identity(previous.get(profile))!==identity(subscriptions.get(profile))){cleanups.push(disconnect(profile));for(const k of badges.keys())if(JSON.parse(k)[0]===profile)badges.delete(k);}save();notify();await Promise.allSettled(cleanups);if(closed)return;await Promise.all(items.filter(s=>s.enabled!==false).map(s=>launchAttach(s.profile,generation)));await replay();});subscriptionChain=task.catch(()=>{});return task;};
 const ack=eventId=>{if(closed)return false;const remaining=state.pending.filter(e=>e.eventId!==eventId);if(remaining.length===state.pending.length)return false;state.pending=remaining;delete state.identities[eventId];save();updateCapacity();return true;};
 const close=()=>{if(closed)return closing;closed=true;generation++;for(const timer of retryTimers.values())clearTimeout(timer);retryTimers.clear();for(const profile of [...sessions.keys()])void disconnect(profile).catch(()=>{});closing=Promise.allSettled([subscriptionChain,...attachmentTasks]).then(()=>Promise.allSettled([...cleanupTasks]));return closing;};
 return {setSubscriptions,ack,replay,status,close};
}
