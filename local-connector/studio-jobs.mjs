import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {deviceQueue} from './queue.mjs';
const script=fileURLToPath(new URL('../scripts/studio-executor.mjs',import.meta.url));
const uuid=/^[a-f0-9-]{36}$/i;
export function studioJobs(root,port,{launch=spawn,allowedBase=process.env.STUDIO_CALLBACK_URL,timeoutMs=11*60*1000}={}){
 const directory=join(root,'studio-jobs'),dataDir=dirname(root);mkdirSync(directory,{recursive:true,mode:0o700});
 // Saving needs a visible foreground editor. One desktop must not foreground
 // two account windows at once. Login and sync share this device queue.
 const active=new Map(),scheduler=deviceQueue(root);
 const path=id=>join(directory,id+'.json');
 const read=id=>existsSync(path(id))?JSON.parse(readFileSync(path(id),'utf8')):null;
 const save=(id,state)=>writeFileSync(path(id),JSON.stringify(state),{mode:0o600});
 return async(req,res,url)=>{
  const match=url.pathname.match(/^\/studio(?:\/([a-f0-9-]{36})(?:\/(cancel))?)?$/i);if(!match)return false;
  const send=(code,value)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));return true;};
  if(req.method==='POST'&&match[2]==='cancel'){const state=read(match[1]);if(!state)return send(404,{message:'任务不存在'});if(scheduler.cancel(match[1])){active.delete(match[1]);save(match[1],{...state,status:'cancelled',stopConfirmed:true,message:'排队任务已移除'});}else if(active.has(match[1])){save(match[1],{...state,status:'stopping',stopConfirmed:false,message:'停止尚未确认，请勿重复保存草稿'});active.get(match[1]).child?.kill('SIGTERM');}return send(200,read(match[1]));}
  if(req.method==='GET'&&match[1]){
   const state=read(match[1]);if(!state)return send(404,{message:'执行任务不存在'});
   if(['running','queued'].includes(state.status)&&!active.has(match[1])){state.status='blocked';state.message='执行设备重启，原稿已保留；请在原电脑核对草稿，勿重复上传';save(match[1],state);}
   return send(200,state);
  }
  if(req.method!=='POST'||match[1])return send(405,{message:'请求方式不支持'});
  let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)return send(413,{message:'执行请求过大'});}
  let input;try{input=JSON.parse(raw);}catch{return send(400,{message:'执行请求格式无效'});}
  const {runId,taskId,profile,apiBase,token,startedAt}=input;
  if(!uuid.test(runId||'')||!uuid.test(taskId||'')||!/^local:[\w-]{1,100}$/.test(profile||'')||typeof token!=='string'||token.length<32||!Number.isFinite(Date.parse(startedAt)))return send(400,{message:'执行任务参数无效'});
  // Callback destination is paired locally; do not run tasks against arbitrary hosts.
  if(!allowedBase||apiBase!==allowedBase)return send(400,{message:'执行设备回传地址与配对配置不一致'});
  const existing=read(runId);if(existing)return send(200,existing);
  if([...active.values()].some(v=>v.profile===profile))return send(409,{message:'此账号正在保存另一条草稿，请稍后重试'});
  if(scheduler.pending().length>=10)return send(409,{message:'执行设备草稿队列已满，请等待当前任务完成'});
  const state={runId,taskId,profile,startedAt,status:'queued',message:'正在等待此电脑上的草稿任务完成'};
  save(runId,state);
  active.set(runId,{profile});
  scheduler.submit({id:runId,start:release=>{
  let child,timer,leaseTimer,done=false;
  const finish=message=>{
   if(done)return;done=true;clearTimeout(timer);clearInterval(leaseTimer);active.delete(runId);
   let evidence;try{evidence=JSON.parse(readFileSync(join(dataDir,'studio-executions',taskId+'.json'),'utf8'));}catch{}
   const valid=evidence?.startedAt===startedAt&&evidence?.runId===runId;
   const stopping=read(runId)?.status==='stopping';
   save(runId,{...state,stopConfirmed:true,status:stopping?'cancelled':valid&&evidence.status==='filled'?'complete':'blocked',message:valid?(evidence.error||'账号、图片、正文和草稿箱已核对'):message,finishedAt:new Date().toISOString()});
   release();
  };
  const remaining=timeoutMs-(Date.now()-Date.parse(startedAt));
  if(remaining<=0){finish('草稿排队超时，未开始上传，请稍后重试');return;}
  save(runId,{...state,status:'running',message:'执行设备正在核对账号并保存草稿'});
  try{
   child=launch(process.execPath,[script,taskId],{cwd:dirname(dirname(script)),stdio:'ignore',env:{...process.env,DATA_DIR:dataDir,LOCAL_CONNECTOR_ROOT:root,LOCAL_CONNECTOR_URL:`http://127.0.0.1:${port}`,LOCAL_CONNECTOR_TOKEN:readFileSync(join(root,'connector-token'),'utf8').trim(),STUDIO_URL:apiBase,STUDIO_TOKEN:token,MATRIX_PROFILE:profile,STUDIO_RUN_ID:runId,MATRIX_DEVICE_EPOCH:existsSync(join(root,'device-lease.json'))?JSON.parse(readFileSync(join(root,'device-lease.json'),'utf8')).epoch??'':'',STUDIO_STARTED_AT:startedAt}});
   active.set(runId,{child,profile});
   leaseTimer=setInterval(()=>{try{if(existsSync(join(root,'device-lease.json'))&&JSON.parse(readFileSync(join(root,'device-lease.json'),'utf8')).until<Date.now())child.kill('SIGTERM');}catch{child.kill('SIGTERM');}},1000);leaseTimer.unref();
   timer=setTimeout(()=>{child.kill('SIGTERM');},remaining);timer.unref();
   child.once('error',()=>finish('执行进程无法启动，请检查本机运行环境'));
   child.once('exit',()=>finish('执行进程已退出但未返回保存证据，请在原电脑核对草稿，勿重复上传'));
  }catch{finish('执行进程无法启动');}
  }});
  return send(202,read(runId));
 };
}
