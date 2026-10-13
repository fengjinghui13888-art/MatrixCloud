import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {serial} from './serial';
// @ts-ignore shared ESM contract is also used by the packaged connector.
import {validXhsEvent} from '../shared/xhs-events.mjs';

type Hint={eventId:string;kind:string;deviceId:string;profile:string;handle:string;workspace:string};
type RecordState={status:string;message:string;pending:Hint[];eventIds:string[];inflight?:{events:Hint[];jobId?:string};job?:any;lastEventAt?:string;lastSyncedAt?:string;recoveryPending?:boolean};
type State={enabled:boolean;accounts:Record<string,RecordState>};
export function createEventSync(options:any){
 const file=options.path||join(options.dir,'event-sync.json'),workspace:string=options.workspace||options.scope?.current?.()||'owner';
 mkdirSync(dirname(file),{recursive:true,mode:0o700});
 const load=():State=>{if(!existsSync(file))return {enabled:false,accounts:{}};const data=JSON.parse(readFileSync(file,'utf8'));if(typeof data.enabled!=='boolean'||!data.accounts||typeof data.accounts!=='object')throw Error('事件队列损坏，请先核对记录');return data;};
 let state=load();
 const save=()=>{const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(state),{mode:0o600,flag:'wx'});renameSync(temp,file);};
 for(const s of Object.values(state.accounts))if(s.inflight&&s.status==='running'){s.status='paused';s.recoveryPending=true;s.message='服务已重启，原任务结果待核对；不会重复采集';}
 if(Object.values(state.accounts).some(s=>s.recoveryPending))save();
 const locked=<T>(work:()=>Promise<T>)=>serial(file,async()=>{state=load();return work();});
 const accounts=async():Promise<any[]>=>options.accounts||await options.store.listAccounts();
 const record=(id:string):RecordState=>state.accounts[id]||=( {status:'idle',message:'等待浏览器事件',pending:[],eventIds:[]} );
 const view=async()=>({enabled:state.enabled,mode:'event',accounts:(await accounts()).map(a=>{const s=record(a.id);return {accountId:a.id,status:s.status,message:s.message,lastEventAt:s.lastEventAt,lastSyncedAt:s.lastSyncedAt,job:s.job,pendingKinds:[...new Set(s.pending.map(e=>e.kind))]};})});
 const pause=(s:RecordState,message:string)=>{s.status='paused';s.message=message;};
 async function finish(job:any){
  if(!job||!['complete','partial','blocked'].includes(job.status))return;
  const s=state.accounts[job.accountId];if(!s)return;
  // A manual sync completion can release a busy event. Blocked/unknown outcomes never do.
  if(s.inflight&&s.inflight.jobId!==job.id)return;
  if(job.status==='blocked'){pause(s,job.message||'任务失败或停止尚未确认，自动同步已暂停');s.job=job;save();return;}
  if(s.inflight){s.inflight=undefined;s.job=job;s.lastSyncedAt=job.finishedAt||new Date().toISOString();if(s.recoveryPending){s.recoveryPending=false;s.status='idle';}}
  if(s.status!=='paused'){s.status=s.pending.length?'pending':'idle';s.message=s.pending.length?'等待处理已合并事件':'等待浏览器事件';}
  save();
 }
 async function reconcile(){
  for(const s of Object.values(state.accounts)){
   if(!s.inflight)continue;
   if(!s.inflight.jobId){pause(s,'任务启动结果未知，自动同步已暂停');continue;}
   const job=await options.xhsSync?.status?.(s.inflight.jobId);
   if(!job){pause(s,'找不到任务的可靠执行结果，自动同步已暂停');continue;}
   if(['complete','partial','blocked'].includes(job.status))await finish(job);
  }
 }
 async function drain(deviceId?:string){
  await reconcile();
  if(!state.enabled){save();return;}
  for(const a of await accounts()){
   const s=record(a.id);if(!s.pending.length||s.inflight||s.status==='paused')continue;
   const hint=s.pending[0],bound=await options.connectorChannel.binding(workspace,a.profile);
   if(hint.workspace!==workspace||hint.profile!==a.profile||hint.handle!==a.handle||bound!==hint.deviceId){pause(s,'原账号绑定已改变，旧事件不会在新设备执行');save();continue;}
   if(deviceId&&deviceId!==hint.deviceId)continue;
   if(!await options.connectorChannel.online(hint.deviceId)){s.status='offline';s.message='原执行电脑离线，事件已保存';save();continue;}
   if(await options.isBusy?.(a)||await options.xhsSync?.running?.(a.id)){s.status='busy';s.message='等待已有任务结束，事件已合并';save();continue;}
   try{
    const health=await options.connectorChannel.json(workspace,hint.deviceId,'GET','/verify');
    if(!health.capabilities?.includes('event-sync')||!health.capabilities?.includes('stop-ack')){pause(s,'请更新执行电脑连接器后再启用事件同步');save();continue;}
    const identity=await options.connectorChannel.json(workspace,hint.deviceId,'GET','/accounts/'+a.profile.slice(6)+'/state');
    if(!identity.creatorLoggedIn||!identity.webLoggedIn||String(identity.handle??identity.creatorHandle??'').toLowerCase()!==a.handle.toLowerCase()||String(identity.webHandle??'').toLowerCase()!==a.handle.toLowerCase()){pause(s,'账号登录身份未核验，自动同步已暂停');save();continue;}
   }catch(error){s.status='offline';s.message='原执行电脑状态未确认，事件保留等待重连';save();continue;}
   const events=s.pending.splice(0);s.inflight={events};s.status='running';s.message='正在启动事件增量同步';save();
   try{
    const start=options.start||options.xhsSync.start.bind(options.xhsSync);
    const job=await start(a.id,a.profile,undefined,{mode:'incremental',source:'event',eventKinds:[...new Set(events.map(e=>e.kind))],eventDeviceId:hint.deviceId,expectedHandle:hint.handle});
    s.job=job;s.inflight.jobId=job.id;s.message='正在执行事件增量同步';save();
   }catch(error){pause(s,error instanceof Error?error.message:'任务启动结果未知，自动同步已暂停');save();}
  }
 }
 return {
  pauseAccounts:(ids:string[],message:string)=>locked(async()=>{for(const id of ids)pause(record(id),message);save();return view();}),
  deliveryFailed:(ids:string[],status:'offline'|'paused',message:string)=>locked(async()=>{for(const id of ids){const s=record(id);if(s.status!=='paused'){s.status=status;s.message=message;}}save();return view();}),
  status:()=>locked(async()=>view()),
  setEnabled:(enabled:boolean)=>locked(async()=>{
   state.enabled=enabled;
   if(!enabled){for(const s of Object.values(state.accounts)){s.pending=[];if(!s.inflight){s.status='idle';s.message='事件同步已关闭';}}}
   else for(const s of Object.values(state.accounts))if(s.status==='paused'&&s.inflight?.jobId){
    const job=await options.xhsSync?.status?.(s.inflight.jobId);
    // Re-enabling is an explicit user action. Only a confirmed manual stop,
    // with no platform error, can safely return the persisted hints to pending.
    if(job?.status==='blocked'&&job.stopConfirmed===true&&job.message==='停止已确认'&&!job.error){s.pending=[...s.inflight.events,...s.pending].filter((e,i,all)=>all.findIndex(x=>x.kind===e.kind&&x.deviceId===e.deviceId&&x.profile===e.profile&&x.handle===e.handle)===i);s.inflight=undefined;s.recoveryPending=false;s.status='pending';}
   }
   save();if(enabled)await drain();return view();
  }),
  receive:(input:any)=>locked(async()=>{
   if(input?.workspace!==workspace||!validXhsEvent(input?.event))return false;
   const a=(await accounts()).find(a=>a.profile===input.event.profile);if(!a)return false;
   if(await options.connectorChannel.binding(workspace,a.profile)!==input.deviceId)return false;
   const s=record(a.id);if(s.eventIds.includes(input.event.eventId))return true;
   s.eventIds=[...s.eventIds,input.event.eventId].slice(-256);s.lastEventAt=new Date().toISOString();
   if(state.enabled&&s.status!=='paused'){
    const hint={eventId:input.event.eventId,kind:input.event.kind,workspace,deviceId:input.deviceId,profile:a.profile,handle:a.handle};
    const sameSource=(e:Hint)=>e.workspace===hint.workspace&&e.deviceId===hint.deviceId&&e.profile===hint.profile&&e.handle===hint.handle;
    if(s.pending.some(e=>!sameSource(e)))pause(s,'原账号绑定已改变，旧事件不会在新设备执行');
    else if(!s.pending.some(e=>sameSource(e)&&e.kind===hint.kind))s.pending.push(hint);
    if(!s.inflight&&s.status!=='paused')s.status='pending';
   }
   save();return true;
  }).then(accepted=>{
   // Return the persisted ACK before issuing channel requests: incoming WS frames
   // are serialized and their responses must not wait behind this event frame.
   if(accepted)void locked(async()=>{await drain(input.deviceId);}).catch(()=>{});
   return accepted;
  }),
  drainForDevice:(deviceId?:string)=>locked(async()=>{await drain(deviceId);return view();}),
  observeCompletion:(job:any)=>locked(async()=>{await finish(job);await drain();return view();})
 };
}
