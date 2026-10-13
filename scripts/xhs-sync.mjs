import {readFile,writeFile,rename,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {projectPath} from './runtime-path.mjs';
import {collectWithPlaywright} from './xhs-playwright.mjs';
import {archiveMedia} from './xhs-media.mjs';
import {collectRemote,copyRemoteMedia,verifiedMedia} from './remote-sync.mjs';
import {acquireProfileLock} from './studio-lock.mjs';
const statePath=process.env.SYNC_STATE_PATH,id=process.argv[2],profile=process.env.SYNC_PROFILE,accountId=process.env.SYNC_ACCOUNT_ID;
const syncMode=process.env.SYNC_MODE==='incremental'?'incremental':undefined,syncSource=process.env.SYNC_SOURCE==='event'?'event':undefined;
let knownComments=[],knownMessages=[];
const base=process.env.SYNC_API_BASE||'http://127.0.0.1:4174',token=process.env.STUDIO_TOKEN;
let writes=Promise.resolve();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const readState=async()=>{for(let attempt=0;attempt<4;attempt++){try{const raw=await readFile(statePath,'utf8');if(!raw.trim())throw Error('empty state');return JSON.parse(raw);}catch{await pause(25*(attempt+1));}}throw Error('同步状态暂不可用，请保持执行电脑在线后重试');};
const update=patch=>writes=writes.catch(()=>{}).then(async()=>{
 const old=await readState();
 if(old.status==='blocked'&&(patch.stopConfirmed!==true||old.stopConfirmed===true))return;
 const receipt=old.status==='blocked'?{stopConfirmed:true}:patch;
 const saved=process.env.SYNC_DURABLE==='1'?await api('sync-jobs/'+id+'/progress',receipt):{...old,...receipt};
 if(saved.status==='blocked'&&patch.status!=='blocked'&&patch.stopConfirmed!==true)throw Error(saved.message||'同步已取消');
 await writeFile(statePath+'.tmp',JSON.stringify(saved),{mode:0o600});await rename(statePath+'.tmp',statePath);
});
const api=async(path,body)=>{const r=await fetch(base+'/api/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});const raw=await r.text();let v;try{v=JSON.parse(raw);}catch{throw Error(`同步服务返回无效结果（HTTP ${r.status}）`);}if(!r.ok)throw Error(v.message);return v;};
let release,result,stage='account';const timings={};let stageStarted=Date.now();
const progress=async patch=>{if(patch.stage&&patch.stage!==stage){timings[stage]=(timings[stage]||0)+Date.now()-stageStarted;stage=patch.stage;stageStarted=Date.now();}await update({...patch,timings});};
try{
  const baselinePath=process.env.SYNC_BASELINE_PATH;
  if(baselinePath){
   if(!/^[a-f0-9-]{36}$/.test(id)||resolve(baselinePath)!==resolve(statePath.replace(/\.json$/,'.baseline.json'))||(await stat(baselinePath)).size>6*1024*1024)throw Error('同步基线文件无效');
   const baseline=JSON.parse(await readFile(baselinePath,'utf8'));
   if(baseline.jobId!==id||baseline.accountId!==accountId||[baseline.knownComments,baseline.knownMessages].some(ids=>!Array.isArray(ids)||ids.length>10000||ids.some(x=>typeof x!=='string'||!x||x.length>256)))throw Error('同步基线归属或内容无效');
   knownComments=baseline.knownComments;knownMessages=baseline.knownMessages;
  }else if(syncMode==='incremental')throw Error('增量同步缺少已核验基线文件');
  if(!token)throw Error('同步执行器缺少工作区凭证');
  await progress({stage:'account',message:'正在读取账号绑定信息'});
  const target=(await api('accounts')).find(a=>a.id===accountId);if(!target||target.profile!==profile)throw Error('账号绑定已改变，请重新同步');
  await progress({stage:'starting',message:'正在读取已保存内容，准备增量同步'});
 const knownNotes=[];for(let page=1;page<=1000;page++){const batch=await api(`accounts/${encodeURIComponent(accountId)}/notes?page=${page}&pageSize=100`);knownNotes.push(...batch.items??[]);if(!batch.hasNext)break;}
 const availableAssets=await verifiedMedia(knownNotes,join(process.env.SYNC_DATA_DIR||projectPath('work','grey'),'media'));
 const saveSnapshot=async snapshot=>{
  const current=(await api('accounts')).find(a=>a.id===accountId);
  if(snapshot.account.id!==target.id||snapshot.account.handle!==target.handle||current?.profile!==profile)throw Error('账号绑定发生变化，结果未保存');
  for(const [key,items]of [['notes',snapshot.notes.map(n=>({...n,mediaAssets:undefined}))],['comments',snapshot.comments],['messages',snapshot.messages||[]]])for(let i=0;i<items.length;i+=10)await api('import',{account:snapshot.account,notes:[],comments:[],messages:[],[key]:items.slice(i,i+10)});
 };
 release=await acquireProfileLock(join(process.env.DATA_DIR??projectPath('work','grey'),'studio-locks'),profile,id);
 const remoteBase=process.env.LOCAL_CONNECTOR_URL?.replace(/\/$/,'');
 const remoteOptions=remoteBase?{base:remoteBase,token:process.env.LOCAL_CONNECTOR_TOKEN?.trim()||(await readFile(process.env.LOCAL_CONNECTOR_TOKEN_FILE||join(process.env.LOCAL_CONNECTOR_ROOT,'connector-token'),'utf8')).trim(),jobId:id,target,knownNotes,knownComments,knownMessages,mode:syncMode,source:syncSource,onProgress:progress,onCheckpoint:saveSnapshot}:null;
 if(remoteOptions)remoteOptions.availableAssets=availableAssets;
 result=remoteOptions?await collectRemote(remoteOptions):await collectWithPlaywright({profile,target,knownNotes,knownCommentIds:knownComments,knownMessageIds:knownMessages,mode:syncMode,onProgress:progress,onCheckpoint:saveSnapshot});
 const current=(await api('accounts')).find(a=>a.id===accountId);if(current?.profile!==profile||current?.handle!==target.handle)throw Error('账号绑定发生变化，结果未保存');
 const importResult=async()=>{
  // Import only this account's records. Store.importSnapshot upserts by id and
  // never replaces or clears records owned by other accounts.
  for(const [key,items]of [['notes',result.notes],['comments',result.comments],['messages',result.messages]])for(let i=0;i<items.length;i+=10)await api('import',{account:result.account,notes:[],comments:[],messages:[],[key]:items.slice(i,i+10)});
 };
 await progress({stage:'saving',message:'正在保存已核验的正文、评论和私信'});if(remoteOptions)await saveSnapshot(result);else await importResult();
 await writeFile(statePath.replace(/\.json$/,'.evidence.json'),JSON.stringify(result.evidence,null,2),{mode:0o600});
 await progress({stage:'media',message:'文字已保存，正在下载原图和视频'});
 let media;
 try{
  const root=join(process.env.SYNC_DATA_DIR||projectPath('work','grey'),'media');
  const onProgress=p=>progress({stage:'media',media:p,message:`内容已保存，正在传输媒体 ${p.finished}/${p.total}`});
  media=remoteOptions?await copyRemoteMedia({...remoteOptions,result,root,onProgress}):await archiveMedia({notes:result.notes,accountId,root,context:result.context,onProgress,availableAssets});
  if(remoteOptions&&result.media?.failed)media.sourceFailures=result.media.failed;
 }
 catch(e){media={failed:1,errors:[{error:e.message}]};}
 await progress({stage:'saving',message:'正在保存本地媒体索引'});await importResult();
 timings[stage]=(timings[stage]||0)+Date.now()-stageStarted;
 const counts={notes:result.notes.length,comments:result.comments.length,messages:result.messages.length};
 await update({status:'partial',stage:'finished',counts,coverage:result.coverage,loginRequired:result.loginRequired,media,timings,evidence:result.evidence,
  message:`已同步 ${counts.notes} 篇笔记、${counts.comments} 条评论、${counts.messages} 条私信；已保存媒体 ${(media.saved||0)+(media.cached||0)} 个${media.failed?`，传输失败 ${media.failed} 个`:''}${media.sourceFailures?`，执行设备采集媒体失败 ${media.sourceFailures} 项`:''}。${Object.values(result.coverage).join('；')}。尚未证明覆盖全部历史与所有消息类型。`,finishedAt:new Date().toISOString()});
}catch(e){await update({status:'blocked',stage:'blocked',errorStage:stage,error:e.message,message:e.message||'同步失败',finishedAt:new Date().toISOString()});process.exitCode=1;}
finally{await result?.browser?.close().catch(()=>{});await release?.().catch(()=>{});}
