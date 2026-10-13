// Only normalizes fields returned by the logged-in website. Missing fields stay missing.
export function extractContent(input,accountId,context={}){
 const notes=new Map(),comments=new Map(),messages=new Map();let followers=null;
 const str=v=>typeof v==='string'?v:'';const count=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(String(v).replaceAll(',',''));return Number.isFinite(n)&&n>=0?n:null;};
 const url=v=>typeof v==='string'&&/^https?:\/\//.test(v)?v:null;
 const date=v=>{if(typeof v==='number'&&Number.isFinite(v)){try{return new Date(v<1e12?v*1000:v).toISOString();}catch{return '';}}return str(v);};
 const media=image=>url(image?.urlDefault)||url(image?.urlPre)||url(image?.url_default)||url(image?.url)||url(image?.url_pre)||url(image?.info_list?.find(x=>x.image_scene==='WB_DFT')?.url)||url(image);
 const seen=new Set();
 function walk(o,depth=0){if(!o||typeof o!=='object'||depth>18||seen.has(o))return;seen.add(o);
  if(Array.isArray(o)){for(const item of o)walk(item,depth+1);return;}
  if(o.comment_info?.id&&o.item_info?.id&&o.user_info){
   walk({comment_id:o.comment_info.id,note_id:o.item_info.id,content:o.comment_info.content,user_info:o.user_info,time:o.time},depth+1);
  }
  if(o.id&&o.sender_id&&o.receiver_id&&context.selfId&&(o.sender_id===context.selfId||o.receiver_id===context.selfId)&&!o.group_chat){
   let payload;try{payload=JSON.parse(o.content);}catch{payload={content:typeof o.content==='string'?o.content:''};}
   let body=payload?.content;try{const nested=JSON.parse(body);body=nested.content||nested.title||payload.front_chain;}catch{}
   if(typeof body!=='string'||!body.trim())body=payload?.front_chain;
   if(typeof body==='string'&&body.trim()){
    const outgoing=o.sender_id===context.selfId,peer=outgoing?o.receiver_id:o.sender_id;
    messages.set(o.id,{id:o.id,accountId,conversationId:peer,author:outgoing?(context.selfName||context.selfId):(context.peers?.[peer]||peer),body:o.revoked?'[消息已撤回]':body,createdAt:date(o.created_at),direction:outgoing?'outgoing':'incoming'});
   }
  }
  if(o.fans_count!==undefined||o.fansCount!==undefined)followers=count(o.fans_count??o.fansCount);
  const noteId=str(o.note_id||o.noteId||(o.image_list||o.imageList||o.images_list||o.video||o.type==='video'?o.id:''));
  const title=str(o.display_title||o.displayTitle||o.title);const imageList=o.image_list||o.imageList||o.images_list||o.images;
  if(noteId&&title&&(Array.isArray(imageList)||o.video||o.type==='video'||o.type==='normal')){
   const images=Array.isArray(imageList)?imageList.map(media).filter(Boolean):[];
   const streams=o.video?.media?.stream;const stream=streams?Object.values(streams).flat().find(v=>v?.master_url||v?.masterUrl):null;
   const videoUrl=url(o.video?.url)||url(stream?.master_url||stream?.masterUrl);const metrics=o.interact_info||o.interactInfo||o;
   notes.set(noteId,{id:noteId,accountId,title,summary:str(o.desc||o.description||o.content)||null,cover:media(o.cover)||images[0]||null,url:url(o.url)||`https://www.xiaohongshu.com/explore/${noteId}`,publishedAt:date(o.publish_time||o.publishTime||o.time),mediaType:o.type==='video'||o.video?'video':'image',images,videoUrl,metrics:{likes:count(metrics.liked_count??metrics.likedCount??metrics.likes),collects:count(metrics.collected_count??metrics.collectedCount),comments:count(metrics.comment_count??metrics.commentCount??metrics.comments_count),shares:count(metrics.share_count??metrics.shareCount??metrics.shared_count)}});
  }
  const commentId=str(o.comment_id||o.commentId||(o.user_info&&o.content&&(o.note_id||context.noteId)?o.id:''));
  const commentBody=str(o.content||o.comment_content||o.commentContent||o.text);
  const commentUser=o.user_info||o.userInfo||o.author||o.user;
  const commentNote=str(o.note_id||o.noteId||o.note?.id||context.noteId);
  if(commentId&&commentNote&&commentBody&&commentUser){comments.set(commentId,{id:commentId,accountId,noteId:commentNote,author:str(commentUser.nickname||commentUser.nick_name||commentUser.name)||'未提供昵称',avatar:media(commentUser.image||commentUser.avatar)||'',body:commentBody,createdAt:date(o.create_time||o.createTime||o.time),status:'pending',tags:[]});}
  const messageId=str(o.message_id||o.messageId||o.msg_id||o.msgId),conversationId=str(o.conversation_id||o.conversationId||o.chat_id||o.chatId||o.session_id);
  const sender=o.sender||o.from_user||o.user||o.author; const messageBody=str(o.content||o.message||o.text);
  if(messageId&&conversationId&&messageBody&&sender){const self=typeof o.is_self==='boolean'?o.is_self:(o.direction==='outgoing'||o.send_type==='1');messages.set(messageId,{id:messageId,accountId,conversationId,author:str(sender.nickname||sender.nick_name||sender.name)||'未提供昵称',body:messageBody,createdAt:date(o.create_time||o.createTime||o.time),direction:self?'outgoing':'incoming'});}
  for(const v of Object.values(o))walk(v,depth+1);
 }
 walk(input);return {notes:[...notes.values()],comments:[...comments.values()],messages:[...messages.values()],followers};
}
// This expression is run in the real browser; only website state and rendered media are read.
export function readContentPage(){
 // Framework state can be enormous, circular, and too deeply nested for CDP
 // serialization.  Structured API responses are collected through Network;
 // this DOM reader deliberately returns no framework state and stays safe on
 // every route.
 const safe={};
 const links=[...document.querySelectorAll('a[href]')].map(a=>({text:a.textContent.trim(),url:a.href}));
 const next=[...document.querySelectorAll('button,a,[role="button"]')].filter(e=>/^(下一页|下一页 >|Next)$/i.test((e.innerText||e.getAttribute('aria-label')||'').trim()));
 const cards=[...document.querySelectorAll('.note-card')].map(card=>{
  const impression=card.getAttribute('data-impression')||'';
  const noteId=(impression.match(/noteId[^\dA-Za-z_-]*([\w-]+)/)||[])[1]||'';
  const title=card.querySelector('.note-card__title')?.textContent?.trim()||'';
  const publishedAt=card.querySelector('.note-card__time')?.textContent?.trim()||'';
  const cover=card.querySelector('.note-card__media img.content')?.src||card.querySelector('.note-card__media .media-bg')?.style.backgroundImage?.match(/url\(["']?(.*?)["']?\)/)?.[1]||null;
  const mediaType=card.querySelector('.note-card__media img.play')?'video':'image';
  const stats=[...card.querySelectorAll('.note-card__stats .note-card__stat, .note-card__stat')].map(e=>Number((e.textContent||'').trim())).filter(Number.isFinite);
  return {id:noteId,title,publishedAt,cover,mediaType,stats};
 }).filter(c=>c.title);
 return {state:safe,url:location.href,text:(document.body?.innerText||'').slice(0,12000),links,cards,nextCount:next.length,nextEnabled:next.length===1&&!next[0].disabled&&next[0].getAttribute('aria-disabled')!=='true'};
}
