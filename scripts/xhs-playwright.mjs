import {createActionPacer} from './action-pacing.mjs';
import {executionGuard} from './execution-guard.mjs';
import {chromium} from 'playwright-core';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {projectPath} from './runtime-path.mjs';
import {extractContent} from './xhs-content.mjs';
import {captureNetwork} from './xhs-network.mjs';
import {needsNoteDetail} from './sync-policy.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(read,accept,timeout=12000){const end=Date.now()+timeout;let value;do{value=await read();if(accept(value))return value;await pause(150);}while(Date.now()<end);return value;}

// Project only the requested note's primitive fields. Never serialize framework stores.
export function readWebNote(id){
 const raw=window.__INITIAL_STATE__?.note?.noteDetailMap;
 const map=raw?.value??raw;const entry=map?.[id];const n=entry?.note?.value??entry?.note;
 if(!n||n.noteId!==id)return null;
 const streams=n.video?.media?.stream||{};
 const videos=Object.values(streams).flat().filter(s=>s&&typeof s==='object');
 const stream=videos.find(s=>s.videoCodec==='h264'||s.video_codec==='h264')||videos.find(s=>s.masterUrl||s.master_url);
 return {noteId:n.noteId,title:n.title||'',desc:typeof n.desc==='string'?n.desc:null,type:n.type,time:n.time,
  user:{userId:n.user?.userId||n.user?.user_id||''},
  imageList:(n.imageList||[]).slice(0,100).map(i=>({urlDefault:i.urlDefault||i.url_default||i.url||i.urlPre||''})),
  interactInfo:{likedCount:n.interactInfo?.likedCount,collectedCount:n.interactInfo?.collectedCount,commentCount:n.interactInfo?.commentCount,shareCount:n.interactInfo?.shareCount},
  video:stream?{url:stream.masterUrl||stream.master_url}:undefined};
}

export function filterKnownSyncRecords(snapshot,knownCommentIds=[],knownMessageIds=[]){
 const comments=new Set(knownCommentIds),messages=new Set(knownMessageIds);
 return {comments:(snapshot?.comments||[]).filter(item=>!comments.has(item.id)),messages:(snapshot?.messages||[]).filter(item=>!messages.has(item.id))};
}

// The baseline comes from this account's stored records, never public feeds.
// It is usable only after both currently authenticated site identities match.
export function verifiedIncrementalNoteOwnership({mode,target,knownNotes=[],creatorIdentity,webIdentity}={}){
 if(mode!=='incremental'||!target?.id||!target?.handle||!creatorIdentity?.userId||String(creatorIdentity.redId)!==String(target.handle)||webIdentity?.guest===true||!webIdentity?.user_id||!webIdentity?.red_id||String(webIdentity.user_id)!==String(creatorIdentity.userId)||String(webIdentity.red_id)!==String(target.handle))return new Set();
 return new Set(knownNotes.filter(n=>n?.accountId===target.id&&typeof n.id==='string'&&n.id).map(n=>n.id));
}

export async function collectWithPlaywright({profile,target,knownNoteIds=[],knownNotes=[],knownCommentIds=[],knownMessageIds=[],mode,onProgress,onCheckpoint,signal}){
 const id=profile.slice(6);if(!profile.startsWith('local:')||!/^[\w-]{1,100}$/.test(id))throw Error('只支持本机独立账号');
 const root=process.env.LOCAL_CONNECTOR_ROOT||projectPath('work','grey','local-connector');
 const guard=executionGuard(root,profile),pace=createActionPacer({signal});guard.check();
 const token=(await readFile(join(root,'connector-token'),'utf8')).trim();
 const response=await fetch(`http://127.0.0.1:${process.env.LOCAL_CONNECTOR_PORT||47821}/accounts/${id}/connect`,{method:'POST',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('本机账号连接失败');const {debugPort}=await response.json();
 // Chrome may need several seconds to expose all pages after a visible profile
 // is resumed. Keep this bounded but long enough for real customer machines.
 const browser=await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`,{timeout:30000});
 const context=browser.contexts()[0];context.setDefaultTimeout(8000);context.setDefaultNavigationTimeout(15000);
 const records=[],owned=new Map(),notes=new Map(),comments=new Map(),messages=new Map(),peers={},chatInfo=new Map();
 const known=new Set([...knownNoteIds,...knownNotes.filter(n=>!needsNoteDetail(n)).map(n=>n.id)]);
 const previous=new Map(knownNotes.map(n=>[n.id,n]));
 const knownComments=new Set(knownCommentIds),knownMessages=new Set(knownMessageIds);
 const coverage={notes:'未读取',comments:'未读取',messages:'未读取'},detailErrors=[];let creatorIdentity,webIdentity,storedOwnership=new Set(),storedOwnershipReady=false;
 const network=captureNetwork(context,r=>{
  records.push(r);
  if(r.path==='/api/galaxy/user/info')creatorIdentity=r.body.data;
  // XHS renamed the self identity endpoint in newer web builds.  Accept
  // either form while retaining the same strict account-id comparison in
  // assertWeb().
  if(/\/user\/(?:me|selfinfo)$/.test(r.path))webIdentity=r.body.data;
  if(/\/note\/user\/posted$/.test(r.path))for(const n of r.body.data?.notes||[])owned.set(n.id,n);
 },{onHalt:(reason,retryAfter)=>guard.halt(reason,retryAfter)});
 await context.route('**/*',route=>{try{guard.check();network.assert();return route.continue();}catch{return route.abort();}});
 const counts=()=>({notes:notes.size,comments:comments.size,messages:messages.size});
 const progress=(stage,message)=>onProgress?.({stage,message,counts:counts()});
 const creator=context.pages().find(p=>p.url().startsWith('https://creator.xiaohongshu.com/'))||await context.newPage();
 let web;
 const step=async(page)=>{guard.check();network.assert();signal?.throwIfAborted();const warning=await page.locator('body').innerText({timeout:3000}).catch(()=>'');if(/请完成安全验证|访问过于频繁|账号已被限制|账号封禁|异常登录|滑动验证/.test(warning)){guard.halt('平台要求安全验证或账号限制');throw Error('账号出现验证或限制，已停止后续操作');}await pace();guard.check();network.assert();};
 const navigate=async(page,url)=>{await step(page);await page.bringToFront();await page.goto(url,{waitUntil:'domcontentloaded'});};
 function assertCreator(){if(!creatorIdentity?.redId||String(creatorIdentity.redId)!==target.handle)throw Error(`创作后台账号不一致或未登录，目标 ${target.name}（${target.handle}）`);}
 // The selfinfo response in some web builds omits the legacy `guest:false`
 // field.  Presence of both self identifiers is the stable authenticated
 // signal; an explicit guest response is still rejected, and both IDs must
 // match the creator account before any content is imported.
 function assertWeb(){if(!webIdentity||webIdentity.guest===true||!webIdentity.user_id||!webIdentity.red_id)return false;if(String(webIdentity.user_id)!==String(creatorIdentity.userId)||String(webIdentity.red_id)!==target.handle)throw Error('网页版与创作后台账号不一致，本次结果不写入');return true;}
 function merge(found){for(const n of found.notes){if(!owned.has(n.id))continue;const old=notes.get(n.id);notes.set(n.id,{...old,...n,summary:n.summary??old?.summary??null,images:n.images?.length?n.images:old?.images??[],videoUrl:n.videoUrl??old?.videoUrl??null});}const filtered=mode==='incremental'?filterKnownSyncRecords(found,knownComments,knownMessages):found;for(const c of filtered.comments)if(owned.has(c.noteId)||storedOwnership.has(c.noteId))comments.set(c.id,c);for(const m of filtered.messages)messages.set(m.id,m);}
 function consume(){
  // Only verified creator list records establish note ownership. Public recommendations never do.
  for(const n of owned.values())if(!notes.has(n.id)){if(previous.has(n.id))notes.set(n.id,previous.get(n.id));merge(extractContent(n,target.id));}
  if(!assertWeb())return;
  if(!storedOwnershipReady){storedOwnership=verifiedIncrementalNoteOwnership({mode,target,knownNotes,creatorIdentity,webIdentity});storedOwnershipReady=true;}
  for(const r of records){
   if(/\/chats$/.test(r.path))for(const chat of r.body.data?.chats||[]){if(chat.user_id!==creatorIdentity.userId)continue;chatInfo.set(chat.chat_user_id,chat);peers[chat.chat_user_id]=chat.info?.nickname||chat.info?.user_name||chat.chat_user_id;}
  }
  for(const r of records){
   if(!/\/comment\/|\/you\/mentions$|\/messages\/history$/.test(r.path))continue;
   const url=new URL(r.url);merge(extractContent(r.body,target.id,{noteId:url.searchParams.get('note_id'),selfId:creatorIdentity.userId,selfName:target.name,peers}));
  }
 }
 async function drain(){guard.check();await network.flush();consume();}
 try{
  await progress('account','正在核对账号登录');
  await navigate(creator,'https://creator.xiaohongshu.com/new/home');
  await until(()=>creatorIdentity,x=>!!x?.redId);assertCreator();
  const followers=await creator.evaluate(()=>{const span=[...document.querySelectorAll('span')].find(e=>e.textContent?.trim()==='粉丝数'&&e.parentElement?.querySelector('.numerical'));return span?.parentElement?.querySelector('.numerical')?.textContent||null;});
  await progress('notes','账号已核对，正在读取完整笔记列表');
  await navigate(creator,'https://creator.xiaohongshu.com/new/note-manager');
  await until(()=>records.filter(r=>/\/note\/user\/posted$/.test(r.path)),x=>x.length>0);await drain();
  for(let i=0;i<50;i++){
   const lists=records.filter(r=>/\/note\/user\/posted$/.test(r.path));const last=lists.at(-1)?.body.data;
   const pageNotes=last?.notes||[];
   // Incremental sync: once a page contains only notes already stored locally,
   // older pages cannot add anything new because the creator list is newest first.
   if(known.size&&pageNotes.length&&pageNotes.every(n=>known.has(n.id))) { coverage.notes=`已检查到已有内容，共 ${owned.size} 篇`; break; }
   const total=last?.tags?.find(t=>t.id==='special.note_time_desc')?.notes_count;
   if(last&&(last.page===-1||last.has_more===false||Number.isFinite(total)&&owned.size>=total)){coverage.notes=`已核对笔记列表末尾，共 ${owned.size} 篇`;break;}
   await step(creator);const next=creator.getByRole('button',{name:/下一页|Next/i});
   if(await next.count()===1&&await next.isEnabled())await next.click();
   else await creator.mouse.wheel(0,1600);
   const count=lists.length;await until(()=>records.filter(r=>/\/note\/user\/posted$/.test(r.path)).length,n=>n>count,3500);await drain();
   if(records.filter(r=>/\/note\/user\/posted$/.test(r.path)).length===count){coverage.notes=`读取 ${owned.size} 篇，尚未核对分页末尾`;break;}
  }
  web=context.pages().find(p=>p.url().startsWith('https://www.xiaohongshu.com/'))||await context.newPage();
  await onCheckpoint?.({account:target,notes:[...notes.values()],comments:[],messages:[]});
  await progress('comments','正在核对网页版账号并读取评论通知');
  webIdentity=null;await navigate(web,'https://www.xiaohongshu.com/notification');
  await until(()=>webIdentity,x=>!!x);await drain();
  const loggedIn=assertWeb();
  if(!loggedIn){coverage.comments=coverage.messages='网页版尚未登录，请在已打开的该账号窗口扫码后重新同步';}
  else{
   await until(()=>records.some(r=>/\/you\/mentions$/.test(r.path)),Boolean,6000);await drain();
   for(let i=0;i<50;i++){
    const mentions=records.filter(r=>/\/you\/mentions$/.test(r.path));
    if(mentions.at(-1)?.body.data?.has_more===false)break;
    const size=mentions.length;await step(web);await web.mouse.wheel(0,1600);await until(()=>records.filter(r=>/\/you\/mentions$/.test(r.path)).length,n=>n>size,2500);await drain();
    if(mode==='incremental'&&records.filter(r=>/\/you\/mentions$/.test(r.path)).at(-1)&&extractContent(records.filter(r=>/\/you\/mentions$/.test(r.path)).at(-1).body,target.id).comments.some(c=>knownComments.has(c.id)))break;
    if(records.filter(r=>/\/you\/mentions$/.test(r.path)).length===size)break;
   }
   let completeDetails=0;
   for(const n of owned.values()){
    if(known.has(n.id)) continue;
    await progress('notes',`正在读取正文和媒体 ${completeDetails+1}/${owned.size}：${n.display_title||n.id}`);
    try{
     if(!n.xsec_token)throw Error('列表未返回详情凭据');
     const url=`https://www.xiaohongshu.com/explore/${encodeURIComponent(n.id)}?xsec_token=${encodeURIComponent(n.xsec_token)}&xsec_source=${encodeURIComponent(n.xsec_source||'pc_creatormng')}`;
     await navigate(web,url);
     const detail=await until(()=>web.evaluate(readWebNote,n.id),x=>!!x,6000);
     if(!detail)throw Error('网站未提供此笔记详情');
     if(detail.user.userId!==creatorIdentity.userId)throw Error('详情作者不匹配');
     merge(extractContent(detail,target.id));const saved=notes.get(n.id);if(saved&&n.time)saved.publishedAt=n.time;completeDetails++;
     await onCheckpoint?.({account:target,notes:[...notes.values()],comments:[...comments.values()],messages:[...messages.values()]});
     await until(()=>records.some(r=>/\/comment\//.test(r.path)&&new URL(r.url).searchParams.get('note_id')===n.id),Boolean,2000);await drain();
     for(let i=0;i<30;i++){
      const responses=records.filter(r=>/\/comment\//.test(r.path)&&new URL(r.url).searchParams.get('note_id')===n.id);
      if(responses.at(-1)?.body.data?.has_more===false)break;
      const before=responses.length;await step(web);await web.locator('.comments-container').evaluateAll(es=>es.forEach(e=>e.scrollTop=e.scrollHeight));await web.mouse.wheel(0,1000);
      await until(()=>records.filter(r=>/\/comment\//.test(r.path)&&new URL(r.url).searchParams.get('note_id')===n.id).length,x=>x>before,2000);await drain();
      if(mode==='incremental'&&records.filter(r=>/\/comment\//.test(r.path)&&new URL(r.url).searchParams.get('note_id')===n.id).at(-1)&&extractContent(records.filter(r=>/\/comment\//.test(r.path)&&new URL(r.url).searchParams.get('note_id')===n.id).at(-1).body,target.id,{noteId:n.id}).comments.some(c=>knownComments.has(c.id)))break;
      if(records.filter(r=>/\/comment\//.test(r.path)&&new URL(r.url).searchParams.get('note_id')===n.id).length===before)break;
     }
    }catch(e){guard.check();network.assert();if(signal?.aborted)throw e;detailErrors.push({noteId:n.id,error:e.message.split('\n')[0].replace(/https?:\/\/\S+/g,'[地址省略]')});}
   }
   coverage.notes+=`；已读取 ${completeDetails}/${owned.size} 篇正文与媒体详情`;
   coverage.comments=`已收录 ${comments.size} 条评论；${records.filter(r=>/\/you\/mentions$/.test(r.path)).at(-1)?.body.data?.has_more===false?'通知到达末尾':'通知历史未到末尾'}；评论回复完整性仍需逐笔核验`;
   await progress('messages','正在逐个打开私信会话并读取历史消息');
   const chatStart=records.length;await navigate(web,'https://www.xiaohongshu.com/chat');
   await until(()=>records.slice(chatStart).some(r=>/\/v3\/chats$/.test(r.path)),Boolean,6000);await drain();
   for(let pageIndex=0;pageIndex<50;pageIndex++){
    const batches=records.filter(r=>/\/v3\/chats$/.test(r.path));const last=batches.at(-1)?.body.data;
    if(last&&(last.next_ts===-1||Number.isFinite(last.total)&&chatInfo.size>=last.total))break;
    const before=batches.length;await step(web);await web.locator('.xhs-im-conv-list__scroll').evaluateAll(es=>es.forEach(e=>e.scrollTop=e.scrollHeight));
    await until(()=>records.filter(r=>/\/v3\/chats$/.test(r.path)).length,n=>n>before,3000);await drain();
    if(records.filter(r=>/\/v3\/chats$/.test(r.path)).length===before)break;
   }
   let opened=0,verified=0;
   for(const [peer,info]of chatInfo){
    await progress('messages',`正在读取会话 ${opened+1}/${chatInfo.size}：${peers[peer]}`);
    try{
     const entry=web.locator('.xhs-im-conv-item__name').filter({hasText:peers[peer]});
     await entry.first().waitFor({state:'attached',timeout:8000});await entry.first().scrollIntoViewIfNeeded();
     if(await entry.count()!==1)throw Error('会话入口不唯一或尚未加载');
     const count=records.filter(r=>/\/messages\/history$/.test(r.path)).length;await step(web);await entry.click();opened++;
     await until(()=>records.filter(r=>/\/messages\/history$/.test(r.path)).length,n=>n>count,6000);await drain();
     for(let i=0;i<50;i++){
      const history=records.filter(r=>/\/messages\/history$/.test(r.path)).flatMap(r=>r.body.data?.out_message_list||[]).filter(m=>m.sender_id===peer||m.receiver_id===peer);
      if(mode==='incremental'&&history.some(m=>knownMessages.has(String(m.id||m.message_id||m.msg_id||m.store_id)))){verified++;break;}
      const low=Math.min(...history.map(m=>m.store_id));
      if(history.length&&low<=Math.max(1,info.start_store_id||0)){verified++;break;}
      const before=history.length;
      await step(web);await web.locator('.xhs-im-message-list, .xhs-im-msg-list').evaluateAll(es=>es.forEach(e=>e.scrollTop=0));
      await web.mouse.wheel(0,-1600);await pause(500);await drain();
      const after=records.filter(r=>/\/messages\/history$/.test(r.path)).flatMap(r=>r.body.data?.out_message_list||[]).filter(m=>m.sender_id===peer||m.receiver_id===peer).length;
      if(after===before)break;
     }
    }catch(e){guard.check();network.assert();if(signal?.aborted)throw e;detailErrors.push({conversationId:peer,error:e.message.split('\n')[0]});}
   }
   coverage.messages=`已读取 ${opened}/${chatInfo.size} 个会话，${messages.size} 条消息；${verified} 个会话历史到达最早记录`;
  }
  await drain();
  // Re-check both sites before the caller is allowed to import or download.
  creatorIdentity=null;await navigate(creator,'https://creator.xiaohongshu.com/new/home');await until(()=>creatorIdentity,x=>!!x?.redId);assertCreator();
  if(loggedIn){webIdentity=null;await navigate(web,'https://www.xiaohongshu.com/chat');await until(()=>webIdentity,x=>!!x);if(!assertWeb())throw Error('同步过程中网页版登录失效，结果未保存');}
  network.stop();await network.flush();
  const match=followers?.trim().match(/^([\d,.]+)\s*(万|亿)?$/);const followerCount=match?Math.round(Number(match[1].replaceAll(',',''))*(match[2]==='万'?1e4:match[2]==='亿'?1e8:1)):null;
  if(mode==='incremental'){for(const id of knownComments)comments.delete(id);for(const id of knownMessages)messages.delete(id);}
  return {browser,context,account:{...target,followers:followerCount??target.followers,lastSyncedAt:new Date().toISOString(),state:'connected'},notes:[...notes.values()],comments:[...comments.values()],messages:[...messages.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)),coverage,loginRequired:!loggedIn,evidence:{creatorHandle:creatorIdentity.redId,webHandle:loggedIn?webIdentity.red_id:null,responses:network.evidence,errors:[...network.errors,...detailErrors]}};
 }catch(e){network.stop();await browser.close();throw e;}
}
