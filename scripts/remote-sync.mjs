import {mkdir,stat,rename,rm} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {resolve,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

async function call(options,suffix='',body){
 const {base,token,jobId}=options;
 const r=await fetch(base+'/sync/'+encodeURIComponent(jobId)+suffix,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('执行设备请求失败（HTTP '+r.status+'）');
 return r.json();
}
export async function collectRemote(options){
 const {target,knownNotes=[],knownComments=[],knownMessages=[],mode,source,availableAssets=[],onProgress,onCheckpoint,pollMs=1000}=options;
 const accepted=await call(options,'',{target,knownNotes,knownComments,knownMessages,mode,source,availableAssets});
 const queueDeadline=Date.now()+8*60*1000;
 let executionDeadline=accepted.status==='running'?Date.now()+8*60*1000:undefined;
 let cancelled=false,cancellation,stopConfirmed=false;
 const cancel=()=>{
  cancelled=true;
  return cancellation??=call(options,'/cancel',{}).then(async receipt=>{
   if(receipt.stopConfirmed===true&&!stopConfirmed){await onProgress?.({stopConfirmed:true});stopConfirmed=true;}
  }).catch(()=>{});
 };
 const terminate=()=>{void cancel();};
 process.once('SIGTERM',terminate);
 let checkpointAt=0;
 try{
  while(true){
    if(cancelled)throw Error('同步已取消');
    if(Date.now()>=(executionDeadline??queueDeadline))throw Error(executionDeadline===undefined?'执行设备排队超过 8 分钟，请稍后重新同步':'执行设备同步超过 8 分钟，已保存内容保留，请重新同步');
    const state=await call(options);
    if(cancelled)throw Error('同步已取消');
    await onProgress?.({stage:state.status==='queued'?'queued':state.stage||'account',queuePosition:state.status==='queued'?state.queuePosition??null:null,message:state.message||'正在等待执行设备',counts:state.counts,...(state.stopConfirmed===true?{stopConfirmed:true}:{})});
    if(state.stopConfirmed===true)stopConfirmed=true;
   if(state.checkpoint&&Date.now()-checkpointAt>4000){await onCheckpoint?.(await call(options,'/result'));checkpointAt=Date.now();}
    if(['blocked','cancelled','stopping'].includes(state.status))throw Error(state.message||'执行设备同步失败');
    if(state.status==='complete')return {...await call(options,'/result'),remote:options};
    if(executionDeadline===undefined){
     if(Date.now()>=queueDeadline)throw Error('执行设备排队超过 8 分钟，请稍后重新同步');
     if(state.status!=='queued')executionDeadline=Date.now()+8*60*1000;
    }
   await new Promise(r=>setTimeout(r,pollMs));
  }
 }catch(error){await cancel();throw error;}finally{process.off('SIGTERM',terminate);}
}
async function hashFile(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
export async function verifiedMedia(notes,root){
 const base=resolve(root),available=[];
 for(const note of notes)for(const asset of note.mediaAssets||[]){
  const file=resolve(base,asset.path);
  if(!file.startsWith(base+sep))continue;
  if(await stat(file).then(s=>s.size===asset.bytes).catch(()=>false)&&await hashFile(file)===asset.sha256)available.push(note.id+':'+asset.id);
 }
 return available;
}
export async function copyRemoteMedia({base,token,jobId,result,root,onProgress}){
 const summary={saved:0,cached:0,failed:0,total:result.notes.reduce((n,v)=>n+(v.mediaAssets?.length||0),0)};
 const baseDir=resolve(root);await mkdir(baseDir,{recursive:true});
 for(const note of result.notes){
  const valid=[];
  for(const asset of note.mediaAssets||[]){
   let part;
   try{
    const pieces=asset.path.split('/'),dest=resolve(baseDir,asset.path);
    if(pieces.length!==5||pieces.some(p=>!p||p==='..')||asset.path.includes('\\')||!dest.startsWith(baseDir+sep)||decodeURIComponent(pieces[0])!==result.account.id||decodeURIComponent(pieces[3])!==note.id||!/^[a-f0-9]{32}$/.test(asset.id)||!/^[a-f0-9]{64}$/.test(asset.sha256)||asset.bytes>1024**3)throw Error('无效媒体路径');
    if(await stat(dest).then(s=>s.size===asset.bytes).catch(()=>false)&&await hashFile(dest)===asset.sha256){summary.cached++;valid.push(asset);continue;}
    const r=await fetch(base+'/sync/'+jobId+'/media/'+asset.id,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(120000)});
    if(!r.ok||!r.body)throw Error('媒体传输失败');
    await mkdir(dirname(dest),{recursive:true});part=dest+'.part';
    let size=0;const h=createHash('sha256');
    const meter=new Transform({transform(chunk,_enc,cb){size+=chunk.length;if(size>asset.bytes||size>1024**3)return cb(Error('媒体大小不符'));h.update(chunk);cb(null,chunk);}});
    await pipeline(Readable.fromWeb(r.body),meter,createWriteStream(part,{mode:0o600}));
    if(size!==asset.bytes||h.digest('hex')!==asset.sha256)throw Error('媒体完整性校验失败');
    await rename(part,dest);part=null;summary.saved++;valid.push(asset);
   }catch{summary.failed++;}finally{if(part)await rm(part,{force:true});await onProgress?.({...summary,finished:summary.saved+summary.cached+summary.failed});}
  }
  note.mediaAssets=valid;
 }
 return summary;
}
