import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {collectWithPlaywright} from '../scripts/xhs-playwright.mjs';
import {archiveMedia} from '../scripts/xhs-media.mjs';
import {acquireProfileLock} from '../scripts/studio-lock.mjs';
const root=process.env.LOCAL_CONNECTOR_ROOT,jobId=process.argv[2],dir=join(root,'sync-jobs',jobId);
const input=JSON.parse(await readFile(join(dir,'input.json'),'utf8'));
let chain=Promise.resolve(),release,result;
const json=(name,value)=>chain=(name==='state.json'&&value.status==='blocked'?chain.catch(()=>{}):chain).then(async()=>{await writeFile(join(dir,name+'.tmp'),JSON.stringify(value),{mode:0o600});await rename(join(dir,name+'.tmp'),join(dir,name));});
let state={status:'running',stage:'account',message:'正在连接执行设备',checkpoint:false};
const progress=async patch=>{state={...state,...patch};await json('state.json',state);};
const checkpoint=async snapshot=>{await json('result.json',snapshot);await progress({checkpoint:true});};
try{
 await mkdir(join(root,'sync-locks'),{recursive:true});
 release=await acquireProfileLock(join(root,'..','studio-locks'),input.target.profile,jobId);
 result=await collectWithPlaywright({profile:input.target.profile,target:input.target,knownNotes:input.knownNotes,knownCommentIds:input.knownComments||[],knownMessageIds:input.knownMessages||[],mode:input.mode,source:input.source,onProgress:progress,onCheckpoint:checkpoint});
 const {browser,context,...snapshot}=result;
 await checkpoint(snapshot);
 await progress({stage:'media',message:'内容已读取，正在保存媒体'});
 try{snapshot.media=await archiveMedia({notes:snapshot.notes,accountId:snapshot.account.id,root:join(root,'sync-media'),context,availableAssets:input.availableAssets||[],onProgress:p=>progress({stage:'media',message:'正在保存媒体 '+p.finished+'/'+p.total,media:p})});}
 catch(e){snapshot.media={failed:1,message:e.message};}
 await checkpoint(snapshot);await progress({status:'complete',stage:'finished',message:'执行设备采集已完成'});
}catch(e){await progress({status:'blocked',stage:'blocked',errorStage:state.stage,message:e.message?.split('\n')[0]||'执行失败',finishedAt:new Date().toISOString()});}
finally{await result?.browser.close().catch(()=>{});await release?.().catch(()=>{});}
