#!/usr/bin/env node
import {createOnboarding} from './onboarding.mjs';
import {openWorkbench} from './workbench-launch.mjs';
import {executionGuard} from '../scripts/execution-guard.mjs';
import {deviceQueue} from './queue.mjs';
import {createActionPacer} from '../scripts/action-pacing.mjs';
import {createServer} from 'node:http';
import {mkdirSync,existsSync,readFileSync,writeFileSync,unlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {connectorCleanup} from './cleanup.mjs';
import {spawn} from 'node:child_process';
import {timingSafeEqual,randomBytes} from 'node:crypto';
import {connectPage,observePages} from './cdp.mjs';
import {prepareLogin,captureQr} from './login.mjs';
import {createSessionQueue} from './session-queue.mjs';
import {syncJobs} from './sync-jobs.mjs';
import {studioJobs} from './studio-jobs.mjs';
import {readSession as inspectSession} from './session-state.mjs';
import {registerCloudConnector,loadCloudDevice,startCloudHeartbeat,heartbeatCloudConnector,normalizeCloudUrl,resolveCloudTarget} from './cloud-client.mjs';
import {startCloudChannel} from './cloud-channel.mjs';
import {startXhsWatch,isProfileBusy} from './xhs-watch.mjs';
import {findChrome} from './browser-path.mjs';
import {focusBrowserPage} from './browser-focus.mjs';
import {forwardToExisting,reconnectDecision} from './reconnect.mjs';
import {existingConnectorMessage,inspectExistingConnector} from './startup-guard.mjs';
const args=process.argv.slice(2),arg=(n,f)=>{const i=args.indexOf(n);return i<0?f:args[i+1];};
const home=process.env.HOME||process.env.USERPROFILE||process.cwd();
const root=arg('--data-dir',join(home,'.matrix-cloud')),port=Number(arg('--port','47821'));
const cloudUrl=arg('--cloud-url',process.env.MATRIX_CLOUD_URL||'');
const pairingCode=arg('--pairing-code',process.env.MATRIX_CLOUD_PAIRING_CODE||'');
const deviceName=arg('--device-name',process.env.MATRIX_CLOUD_DEVICE_NAME||'');
mkdirSync(root,{recursive:true,mode:0o700});
const tokenPath=join(root,'connector-token');
try{writeFileSync(tokenPath,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
const token=readFileSync(tokenPath,'utf8').trim();
if(token.length<32)throw Error('本机连接器凭证无效');
const chrome=()=>findChrome();
const sessions=new Map(),launches=new Map();
const inSession=createSessionQueue();
const webTabs=new Map();
const focusedWebLogins=new Set();
const handleSync=syncJobs(root),cleanup=connectorCleanup(root);
const desktopQueue=deviceQueue(root),loginReleases=new Map(),loginControllers=new Map();
let handleStudio=studioJobs(root,port),onboarding,reconnectBusy=false,stopCloud=()=>{},cloudNeedsPairing=false,cloudTransition=Promise.resolve();
function connectCloud(device){
 const transition=cloudTransition.catch(()=>{}).then(async()=>{
 await stopCloud();
 cloudNeedsPairing=false;
 handleStudio=studioJobs(root,port,{allowedBase:device.cloudUrl});
 let stopChannel;
 const ownWatcher=startXhsWatch({root,namespace:normalizeCloudUrl(device.cloudUrl)+'|'+device.deviceId,getSession:async profile=>{if(!/^local:[\w-]{1,100}$/.test(profile))return null;const s=load(profile.slice(6));if(!s||s.profile!==profile)return null;return observePages(s.debugPort,{browserUrl:s.browserUrl});},isBusy:profile=>isProfileBusy({root,profile,activeIds:desktopQueue.active(),loginIds:[...loginControllers.keys()]}),onEvent:event=>stopChannel.sendEvent(event),onStatus:state=>{if(state.status==='paused')console.error(state.message);}});
 stopChannel=startCloudChannel(device,{root,port,token,onStatus:status=>{console.log('云端任务通道：'+status);if(status==='connected')void ownWatcher.replay();},onError:()=>console.error('连接暂时中断，正在重连'),onWatch:subscriptions=>ownWatcher.setSubscriptions(subscriptions),onEventAck:eventId=>ownWatcher.ack(eventId)});
 const stopHeartbeat=startCloudHeartbeat(device,{onError:error=>{if(stopCloud!==stopThisCloud)return;if([401,403].includes(error.status)){cloudNeedsPairing=true;void stopThisCloud();console.error('连接器授权已撤销，请使用新的配对码重新授权。');return;}console.error('连接中断，正在等待网络恢复。');}});
 const stopThisCloud=async()=>{stopHeartbeat();stopChannel();await ownWatcher.close();};stopCloud=stopThisCloud;
 server.once('close',()=>{void stopThisCloud();});
 });cloudTransition=transition;return transition;
}
function beginOnboarding(targetCloudUrl=cloudUrl){
 onboarding=createOnboarding({cloudUrl:targetCloudUrl,register:async code=>{await registerCloudConnector({cloudUrl:targetCloudUrl,pairingCode:code,root,deviceName:deviceName||undefined});await connectCloud(await loadCloudDevice(root));}});
 console.log('请在工作台登录并点击授权连接：'+onboarding.url);
 openWorkbench(onboarding.url);
}
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
const html=(res,status,body)=>{res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'"});res.end(body);};
async function readJson(req,max=4096){let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>max)throw Error('请求内容过大');}try{return JSON.parse(body||'{}');}catch{throw Error('请求格式无效');}}
const connectorLanding=(cloud,paired)=>`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>矩阵云连接器</title><style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:48px;line-height:1.7;color:#172033}main{max-width:680px;margin:auto;padding:28px;border:1px solid #dfe5ee;border-radius:16px}a{color:#111;font-weight:600}</style><main><h1>矩阵云连接器正在运行</h1><p>${paired?'这台电脑已经完成授权，连接器正在保持云端通道。':'这台电脑还没有完成工作台授权。'}</p><p>请返回矩阵云工作台，在“账号矩阵 → 连接你的电脑”点击“授权连接这台电脑”。不要在此地址操作账号或任务。</p><p><a href="${cloud}/">打开矩阵云工作台</a></p></main></html>`;
const authorized=req=>{const candidate=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')||'');const expected=Buffer.from(token);return candidate.length===expected.length&&timingSafeEqual(candidate,expected);};
const validId=id=>{if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw Error('无效会话编号');return id;};
function load(id){validId(id);const path=join(root,id,'session.json');return sessions.get(id)||(existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null);}
async function live(s){if(!s)return false;try{process.kill(s.pid,0);const r=await fetch(`http://127.0.0.1:${s.debugPort}/json/version`,{signal:AbortSignal.timeout(1000)});const v=await r.json();return r.ok&&(!s.browserUrl||s.browserUrl===v.webSocketDebuggerUrl);}catch{return false;}}
async function ensureCreatorPage(s){
 const response=await fetch(`http://127.0.0.1:${s.debugPort}/json/list`,{signal:AbortSignal.timeout(2000)});
 const pages=(await response.json()).filter(t=>t.type==='page');
 if(pages.some(t=>t.url.startsWith('https://creator.xiaohongshu.com/')))return;
 const opened=await fetch(`http://127.0.0.1:${s.debugPort}/json/new?${encodeURIComponent('https://creator.xiaohongshu.com/new/home')}`,{method:'PUT',signal:AbortSignal.timeout(3000)});
 if(!opened.ok)throw Error('无法恢复小红书创作平台页面');
}
async function findOrOpenWebPage(s){
 const response=await fetch(`http://127.0.0.1:${s.debugPort}/json/list`,{signal:AbortSignal.timeout(2000)});
 const pages=(await response.json()).filter(t=>t.type==='page');
 const tracked=pages.find(t=>t.id===webTabs.get(s.id)&&(/^(about:blank|https:\/\/(www\.)?xiaohongshu\.com\/)/i.test(t.url||'')));
 if(tracked)return tracked.id;
 const existing=pages.find(t=>/^https:\/\/(www\.)?xiaohongshu\.com\//i.test(t.url||''));
 if(existing){webTabs.set(s.id,existing.id);return existing.id;}
 const opened=await fetch(`http://127.0.0.1:${s.debugPort}/json/new?${encodeURIComponent('https://www.xiaohongshu.com/login')}`,{method:'PUT',signal:AbortSignal.timeout(3000)});
 if(!opened.ok)throw Error('无法打开小红书网页版登录页');
 const tab=await opened.json();webTabs.set(s.id,tab.id);return tab.id;
}
async function findExistingWebPage(s){const r=await fetch(`http://127.0.0.1:${s.debugPort}/json/list`,{signal:AbortSignal.timeout(2000)});return (await r.json()).find(t=>t.type==='page'&&/^https:\/\/(www\.)?xiaohongshu\.com\//i.test(t.url||''))?.id;}
// The QR code is intentionally shown by the customer browser itself.  When
// the creator platform has been verified, bring the XHS web tab to the front
// so Safari/Edge users can keep the workbench open while scanning in the
// connector-owned browser window.
const focusWebLogin=s=>focusBrowserPage({session:s,findPage:findExistingWebPage,connectPage});
const readSession=s=>inspectSession(s,{connectPage,findExistingWebPage});
async function waitForQr(connection,timeout=10000){
 const end=Date.now()+timeout;
 while(Date.now()<end){
  const ready=await connection.evaluate(`!!document.querySelector('img.css-1lhmg90,img[src*="qr" i],canvas,[class*="qr" i]')`).catch(()=>false);
  if(ready)return true;await new Promise(r=>setTimeout(r,250));
 }
 return false;
}
async function ensure(id){
 if(launches.has(id))return launches.get(id);
 const launch=(async()=>{
  let s=load(id);if(await live(s)){await ensureCreatorPage(s);return s;}
  const dir=join(root,id,'chrome-profile');mkdirSync(dir,{recursive:true,mode:0o700});
  const active=join(dir,'DevToolsActivePort');if(existsSync(active))unlinkSync(active);
  let launchError;const child=spawn(chrome(),[`--user-data-dir=${dir}`,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--new-window','https://creator.xiaohongshu.com/login'],{detached:true,stdio:'ignore'});
  child.on('error',e=>{launchError=e;});child.unref();
  const end=Date.now()+15000;
  while(Date.now()<end){
   if(launchError)throw Error('Chrome 启动失败：'+launchError.message);
   if(existsSync(active)){const [p,browserPath]=readFileSync(active,'utf8').trim().split('\n');s={id,pid:child.pid,debugPort:Number(p),profile:`local:${id}`,browserUrl:`ws://127.0.0.1:${p}${browserPath}`,createdAt:new Date().toISOString()};if(await live(s)){writeFileSync(join(root,id,'session.json'),JSON.stringify(s),{mode:0o600});sessions.set(id,s);return s;}}
   await new Promise(r=>setTimeout(r,150));
  }
  throw Error('Chrome 未能启动，请关闭该账号遗留窗口后重新扫码');
 })();launches.set(id,launch);try{return await launch;}finally{launches.delete(id);}
}
const server=createServer(async(req,res)=>{try{
 const u=new URL(req.url,'http://127.0.0.1');
 if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host||''))return json(res,403,{message:'不支持的本机来源'});
 if(u.pathname==='/health'&&req.method==='GET')return json(res,200,{ok:true,connector:'matrix-cloud-local',version:4,capabilities:['account-sync','studio-drafts','device-queue','stop-ack','passive-state','paced-actions','reconnect','event-sync']});
 if(onboarding&&await onboarding.handle(req,res))return;
 if(u.pathname==='/'&&req.method==='GET')return html(res,200,connectorLanding(cloudUrl||process.env.PUBLIC_ORIGIN||'https://47.106.94.169',Boolean(await loadCloudDevice(root).catch(()=>null))));
 if(!authorized(req))return json(res,401,{message:'本机连接器未授权'});
 if(u.pathname==='/reconnect'&&req.method==='POST'){
  if(reconnectBusy)return json(res,409,{message:'连接器正在处理上一条配对请求，请稍后再试'});
  let input;try{input=await readJson(req);}catch(error){return json(res,400,{message:error.message});}
  const requestedCode=String(input.pairingCode||'').trim();
  if(requestedCode&&!/^\d{8}$/.test(requestedCode))return json(res,400,{message:'请输入 8 位配对码'});
  const existing=await loadCloudDevice(root).catch(()=>null);
  let target;
  try{target=normalizeCloudUrl(String(input.cloudUrl||cloudUrl||existing?.cloudUrl||''));}
  catch(error){return json(res,400,{message:error.message||'云端地址无效'});}
  const decision=reconnectDecision({existing,targetCloudUrl:target,pairingCode:requestedCode});
  if(decision.action==='re-pair'){
   cloudNeedsPairing=true;await stopCloud();
   if(input.onboard&&!onboarding)beginOnboarding(target);
   return json(res,409,{ok:false,requiresPairing:true,message:'云端地址已变更，请在新工作台生成配对码后重新授权'});
  }
  if(decision.action==='already-paired'&&!cloudNeedsPairing){
   if(input.onboard)openWorkbench(existing.cloudUrl);
   return json(res,200,{ok:true,alreadyPaired:true,message:'连接器已在运行且已完成配对，请回到工作台使用'});
  }
  if(!requestedCode){
   if(input.onboard&&!onboarding)beginOnboarding(target);
   return json(res,409,{ok:false,requiresPairing:true,message:'连接器需要新的配对码，请回到工作台完成授权'});
  }
  reconnectBusy=true;
  try{
   await registerCloudConnector({cloudUrl:target,pairingCode:requestedCode,root,deviceName:String(input.deviceName||deviceName||'').trim()||undefined,version:'4.0.0'});
   const device=await loadCloudDevice(root);await connectCloud(device);if(input.onboard)openWorkbench(device.cloudUrl);
   return json(res,200,{ok:true,message:'配对已转交给正在运行的连接器，请回到工作台查看设备状态'});
  }catch(error){return json(res,400,{message:error.message||'配对未完成，请生成新配对码'});}
  finally{reconnectBusy=false;}
 }
 if(u.pathname==='/verify'&&req.method==='GET')return json(res,200,{ok:true,connector:'matrix-cloud-local',version:4,capabilities:['account-sync','studio-drafts','device-queue','stop-ack','passive-state','paced-actions','reconnect','event-sync']});
 if(u.pathname==='/cleanup'&&req.method==='POST'){let body='';for await(const c of req){body+=c;if(body.length>1024)throw Error('请求过大');}const input=JSON.parse(body||'{}');return json(res,200,input.manifestId?cleanup.apply(input.manifestId):cleanup.preview());}
 if(await handleStudio(req,res,u))return;
 if(await handleSync(req,res,u))return;
 const m=u.pathname.match(/^\/accounts\/([^/]+)\/(login|state|connect|image|remove|cancel|resume|safety)$/);if(!m)return json(res,404,{message:'接口不存在'});
 const id=validId(decodeURIComponent(m[1]));
 if(m[2]==='cancel')loginControllers.get(id)?.abort();
 return await inSession(id,async()=>{
 if(m[2]==='cancel'&&req.method==='POST'){loginReleases.get(id)?.();return json(res,200,{status:'cancelled',stopConfirmed:true});}
 if(m[2]==='safety'&&req.method==='GET')return json(res,200,executionGuard(root,'local:'+id).status());
 if(m[2]==='resume'&&req.method==='POST'){let body='';for await(const chunk of req){body+=chunk;if(body.length>1024)throw Error('请求过大');}executionGuard(root,'local:'+id).resume(JSON.parse(body||'{}').confirmed);return json(res,200,{state:'normal'});}
 if(['login','connect'].includes(m[2]))executionGuard(root,'local:'+id).check();
 if(m[2]==='remove'&&req.method==='POST'){
   const s=load(id);if(s){try{process.kill(s.pid,'SIGTERM');}catch{};sessions.delete(id);webTabs.delete(id);focusedWebLogins.delete(id);const path=join(root,id);try{rmSync(path,{recursive:true,force:true});}catch{};}
   return json(res,200,{ok:true,accountId:id});
 }
 if(m[2]==='login'&&req.method==='POST'){
  if(desktopQueue.active().length||desktopQueue.pending().length)return json(res,409,{message:'此电脑正在执行其他浏览器任务，请先完成或停止后再打开登录'});
  const controller=new AbortController();loginControllers.set(id,controller);const pace=createActionPacer({signal:controller.signal});
  let release;desktopQueue.submit({id:'login:'+id,start:done=>{release=done;}});const timer=setTimeout(()=>{loginReleases.delete(id);loginControllers.delete(id);release();},180000);timer.unref();loginReleases.set(id,()=>{clearTimeout(timer);loginReleases.delete(id);loginControllers.delete(id);release();});
  try{await pace();const s=await ensure(id);controller.signal.throwIfAborted();const c=await connectPage(s.debugPort);try{await prepareLogin(c);controller.signal.throwIfAborted();await pace();await findOrOpenWebPage(s);}finally{await c.close();}return json(res,201,{accountId:id,profile:s.profile,message:'专属浏览器登录窗口已打开，请在浏览器中使用小红书 App 扫码'});}catch(e){loginReleases.get(id)?.();throw e;}
 }

 const s=load(id);if(!await live(s))return json(res,200,{connected:false,loggedIn:false,creatorLoggedIn:false,webLoggedIn:false,message:'请点击打开小红书，并在执行电脑完成登录'});
 if(m[2]==='connect'&&req.method==='POST')return json(res,200,{debugPort:s.debugPort,profile:s.profile});
 if(m[2]==='image'&&req.method==='GET'){
  const info=await readSession(s);const c=await connectPage(s.debugPort);
  try{
   if(info.stage==='web'){const webId=await findExistingWebPage(s);if(!webId)return json(res,409,{message:'请重新点击打开小红书登录'});await c.page.selectTab(webId);await waitForQr(c);}
   return json(res,200,await captureQr(c));
  }finally{await c.close();}
 }
 if(m[2]!=='state'||req.method!=='GET')return json(res,405,{message:'请求方式不支持'});
 const value=await readSession(s);
 if(value.stage==='web'&&!value.webLoggedIn&&!focusedWebLogins.has(id)){try{if(await focusWebLogin(s))focusedWebLogins.add(id);}catch{/* state remains authoritative; a later poll can retry focus */}}
 if(value.stage!=='web'||value.webLoggedIn||value.loggedIn)focusedWebLogins.delete(id);
 if(value.loggedIn)loginReleases.get(id)?.();return json(res,200,{...value,connected:true,profile:s.profile});
 });
 }catch(e){return json(res,400,{message:e.message||'本机连接器错误'});}}).listen(port,'127.0.0.1',async()=>{
 try {
  const persisted=await loadCloudDevice(root);
  const target=cloudUrl||persisted?.cloudUrl||'';
  const resolved=resolveCloudTarget({device:persisted,cloudUrl:target});
  let device=resolved.requiresPairing?null:(pairingCode?null:resolved.device);
  if(resolved.requiresPairing)cloudNeedsPairing=true;
  if(pairingCode&&target){await registerCloudConnector({cloudUrl:target,pairingCode,root,deviceName:deviceName||undefined,version:'4.0.0'});device=await loadCloudDevice(root);console.log('矩阵云连接器云端配对成功');}
  if(device&&args.includes('--onboard')){
   try{await heartbeatCloudConnector(device);}catch(error){if([401,403].includes(error.status))device=null;else console.error('暂时无法连接工作台，正在等待网络恢复');}
  }
  if(device){await connectCloud(device);if(args.includes('--onboard'))openWorkbench(device.cloudUrl);}
  else if(args.includes('--onboard')&&target)beginOnboarding(target);
  console.log(`矩阵云本机连接器 v4 已启动：http://127.0.0.1:${port}`);
  console.log(device?'云端通道已连接，请回到矩阵云工作台使用。':'等待工作台授权连接，请回到矩阵云工作台完成授权。');
 } catch(error){console.error(`云端配对失败：${error.message}`);server.close();process.exitCode=1;}
});

server.on('error',async error=>{
 if(error.code==='EADDRINUSE'){
  try{
   const status=await inspectExistingConnector({port});
   const capabilities=Array.isArray(status.value?.capabilities)?status.value.capabilities:[];
   if(status.kind!=='connected'||!capabilities.includes('reconnect')){
    console.error(existingConnectorMessage(status));
    process.exitCode=1;
    return;
   }
   const result=await forwardToExisting({port,token,pairingCode,cloudUrl,deviceName,onboard:args.includes('--onboard')});
   console.log(result.message||'已转交给正在运行的连接器。');
   process.exitCode=0;
  }catch(forwardError){
   console.error(forwardError.message||'连接器已经运行，但未能转交本次操作。');
   process.exitCode=1;
  }
  return;
 }
 console.error(`连接器无法启动：${error.message||error.code||'未知错误'}`);process.exitCode=1;
});
