// One persistent socket per page, with deadlines and correlated responses.
import WebSocket from 'ws';

export async function openCdp(url){
 const ws=new WebSocket(url);let seq=0;const pending=new Map();const listeners=new Set(),closeListeners=new Set();
 const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Chrome 页面连接断开'));}pending.clear();};
 ws.addEventListener('close',()=>{fail();for(const fn of closeListeners)fn();});ws.addEventListener('error',fail);
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(!m.id){for(const fn of listeners)fn(m);return;}const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.close();reject(Error('Chrome 连接超时'));},5000);ws.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});ws.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Chrome 连接失败'));},{once:true});});
 return {send:(method,params={},sessionId)=>new Promise((resolve,reject)=>{if(ws.readyState!==WebSocket.OPEN)return reject(Error('Chrome 页面连接断开'));const id=++seq;const timer=setTimeout(()=>{pending.delete(id);const error=Error(`${method} 超时，执行结果未知`);error.code='SCRIPT_TIMEOUT';reject(error);ws.close();},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}),onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},onClose:fn=>{closeListeners.add(fn);return()=>closeListeners.delete(fn);},close:()=>{ws.close();fail();}};
}

// Discovery and flattened CDP sessions observe existing/new dedicated targets.
// No navigation, refresh or platform request: evaluation only observes badges.
export async function observePages(debugPort,{browserUrl}={}){
 if(!browserUrl){const r=await fetch(`http://127.0.0.1:${debugPort}/json/version`,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('Chrome 连接不可用');browserUrl=(await r.json()).webSocketDebuggerUrl;}
 const parsed=new URL(browserUrl);if(parsed.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||Number(parsed.port)!==Number(debugPort))throw Error('Chrome 调试地址无效');
 const browser=await openCdp(browserUrl),targets=new Map(),wanted=new Map(),attaching=new Map(),listeners=new Set(),closeListeners=new Set();let closed=false,enabled=false,closing;
 const accepted=info=>{try{const u=new URL(info.url);return info.type==='page'&&u.protocol==='https:'&&['creator.xiaohongshu.com','www.xiaohongshu.com','xiaohongshu.com'].includes(u.hostname);}catch{return false;}};
 const unreadSource=`(() => {
  if(location.protocol!=='https:'||!['www.xiaohongshu.com','xiaohongshu.com'].includes(location.hostname))return;
  window.__matrixXhsUnreadObserver?.disconnect();
  const selectors={comments:'[data-notification-kind="comments"][data-unread-count],a[href*="/notification"] [class*="badge"]',messages:'[data-notification-kind="messages"][data-unread-count],a[href*="/message"] [class*="badge"]'};
  const documentId=crypto.randomUUID();
  const counts={};const read=()=>{for(const [kind,selector]of Object.entries(selectors)){let count=null;for(const node of document.querySelectorAll(selector)){const value=node.getAttribute('data-unread-count')??node.textContent?.trim();if(/^\\d{1,6}\\+?$/.test(value||''))count=Math.max(count??0,Number(value.replace('+','')));}if(count===null)continue;if(counts[kind]!==count){counts[kind]=count;try{window.matrixXhsUnread(JSON.stringify({kind,count,documentId}));}catch{}}}};
  const start=()=>{read();window.__matrixXhsUnreadObserver=new MutationObserver(read);window.__matrixXhsUnreadObserver.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['data-unread-count','class']});};
  if(document.documentElement)start();else document.addEventListener('DOMContentLoaded',start,{once:true});
 })()`;
 const configure=async sessionId=>{
  await browser.send('Network.enable',{},sessionId);await browser.send('Page.enable',{},sessionId);await browser.send('Runtime.enable',{},sessionId);
  await browser.send('Runtime.addBinding',{name:'matrixXhsUnread'},sessionId);
  const script=await browser.send('Page.addScriptToEvaluateOnNewDocument',{source:unreadSource},sessionId);
  const target=[...targets.values()].find(t=>t.sessionId===sessionId);if(target)target.scriptId=script.identifier;
  await browser.send('Runtime.evaluate',{expression:unreadSource},sessionId);
 };
 const detach=async id=>{wanted.delete(id);const t=targets.get(id);targets.delete(id);if(t&&!closed)await browser.send('Target.detachFromTarget',{sessionId:t.sessionId}).catch(()=>{});};
 const attach=info=>{if(closed)return Promise.resolve();if(!accepted(info))return detach(info.targetId);wanted.set(info.targetId,info);if(targets.has(info.targetId))return Promise.resolve();if(attaching.has(info.targetId))return attaching.get(info.targetId);const task=(async()=>{const {sessionId}=await browser.send('Target.attachToTarget',{targetId:info.targetId,flatten:true});if(closed||!wanted.has(info.targetId)){await browser.send('Target.detachFromTarget',{sessionId}).catch(()=>{});return;}targets.set(info.targetId,{sessionId});if(enabled)await configure(sessionId);})().finally(()=>attaching.delete(info.targetId));attaching.set(info.targetId,task);return task;};
 browser.onEvent(e=>{if(e.method==='Target.targetCreated'||e.method==='Target.targetInfoChanged'){void attach(e.params.targetInfo).catch(()=>{});return;}if(e.method==='Target.targetDestroyed'){void detach(e.params.targetId);return;}if(e.method==='Target.detachedFromTarget'){for(const [id,t]of targets)if(t.sessionId===e.params.sessionId)targets.delete(id);return;}const targetId=[...targets].find(([,t])=>t.sessionId===e.sessionId)?.[0];if(targetId)for(const fn of listeners)fn({...e,targetId});});
 browser.onClose(()=>{closed=true;targets.clear();for(const fn of closeListeners)fn();});
 try{await browser.send('Target.setDiscoverTargets',{discover:true});const {targetInfos}=await browser.send('Target.getTargets');await Promise.all((targetInfos||[]).map(attach));}catch(error){browser.close();throw error;}
 return {send:async(method,params={},targetId)=>{if(method==='Network.enable'){enabled=true;await Promise.all([...targets.values()].map(t=>configure(t.sessionId)));return;}const t=targets.get(targetId);if(!t)throw Error('观察目标已关闭');return browser.send(method,params,t.sessionId);},onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},onClose:fn=>{closeListeners.add(fn);return()=>closeListeners.delete(fn);},close:()=>{if(closed)return closing;closed=true;listeners.clear();const cleanup=[...targets.values()].map(async t=>{await browser.send('Runtime.evaluate',{expression:'window.__matrixXhsUnreadObserver?.disconnect()'},t.sessionId);if(t.scriptId)await browser.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:t.scriptId},t.sessionId);await browser.send('Runtime.removeBinding',{name:'matrixXhsUnread'},t.sessionId);});targets.clear();closing=Promise.allSettled(cleanup).finally(()=>browser.close());return closing;}};
}
export async function connectPage(debugPort){
 const base=`http://127.0.0.1:${debugPort}`;const sockets=new Map();const listeners=new Set();let active;
 const tabs=async()=>{const response=await fetch(base+'/json/list',{signal:AbortSignal.timeout(3000)});return(await response.json()).filter(t=>t.type==='page').map(t=>({...t,page:t.id}));};
 const socket=async(id=active)=>{const t=(await tabs()).find(t=>t.id===id);if(!t)throw Error('目标标签页已关闭');if(!sockets.has(id)){const s=await openCdp(t.webSocketDebuggerUrl);s.onEvent(event=>{for(const fn of listeners)fn({...event,targetId:id});});sockets.set(id,s);}return sockets.get(id);};
 const list=await tabs();active=list.find(t=>/^https:\/\/creator\.xiaohongshu\.com\/(new\/home|home)/.test(t.url))?.id??list.find(t=>t.url.startsWith('https://creator.xiaohongshu.com/'))?.id;
 const cdp=async(method,params)=>(await socket()).send(method,params);
 const cdpFor=async(id,method,params={})=>(await socket(id)).send(method,params);
 const evaluate=async(expression)=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;};
 const page={tabs,getActivePage:()=>active,selectTab:async id=>{if(!(await tabs()).some(t=>t.id===id))throw Error('目标标签页不存在');active=id;},cdp,cdpFor,evaluate,
 newTab:async url=>{const r=await fetch(base+'/json/new?'+encodeURIComponent(url),{method:'PUT'});if(!r.ok)throw Error('无法创建标签页');const t=await r.json();return t.id;},
 goto:async url=>{await cdp('Page.navigate',{url});},
 insertText:text=>cdp('Input.insertText',{text}),
 nativeClick:async(x,y)=>{await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});},
 screenshot:async()=>cdp('Page.captureScreenshot',{format:'png'}),onEvent:async fn=>{listeners.add(fn);return()=>listeners.delete(fn)}};
 return {page,evaluate,activate:()=>cdp('Page.bringToFront'),foreground:()=>cdp('Page.bringToFront'),close:async()=>{for(const s of sockets.values())s.close();}};
}
