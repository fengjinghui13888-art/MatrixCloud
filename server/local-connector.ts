import {spawn,type ChildProcess} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import { scriptPath } from './runtime-paths.js';
import {randomBytes} from 'node:crypto';
export function createLocalConnector(dataDir:string){
 const compatible=(value:any)=>value?.ok===true&&value.version===4&&['device-queue','stop-ack','passive-state','paced-actions'].every(c=>value.capabilities?.includes(c));
 const port=Number(process.env.LOCAL_CONNECTOR_PORT??47821);
 const configuredBase=process.env.LOCAL_CONNECTOR_URL?.trim().replace(/\/$/,'');
 const base=configuredBase||`http://127.0.0.1:${port}`;
 const remote=Boolean(configuredBase);
 let child:ChildProcess|null=null,pending:Promise<any>|null=null;
 const root=resolve(dataDir,'local-connector');mkdirSync(root,{recursive:true,mode:0o700});const path=join(root,'connector-token');
 if(!existsSync(path))writeFileSync(path,randomBytes(32).toString('hex'),{mode:0o600});
 const token=(process.env.LOCAL_CONNECTOR_TOKEN?.trim()||readFileSync(path,'utf8').trim());
 async function status(){
  try{
   const r=await fetch(base+'/verify',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(3000)});
   if(r.status===401||r.status===403)return {ok:false,message:'执行设备配对凭证无效，请重新配置配对'};
   if(!r.ok)return {ok:false,message:'执行设备版本不兼容，请更新连接器'};
   const value=await r.json();return compatible(value)?value:{ok:false,message:'执行设备状态无效'};
  }catch{return null;}
 }
 async function ensure(_profile?:string){if(pending)return pending;pending=(async()=>{
   const s=await status();
   if(compatible(s))return s;
   if(s?.ok===false)throw Error(s.message);
   if(remote)throw Error('本机连接器未连接，请保持连接器运行并检查配对状态');
   if(s)throw Error('旧版本机连接器仍占用端口，请重启连接器');
   if(!child||child.exitCode!==null){child=spawn(process.execPath,[scriptPath('local-connector', 'connector.mjs'),'--data-dir',root,'--port',String(port)],{detached:true,stdio:'ignore'});child.on('error',()=>{});child.unref();}
   for(let i=0;i<50;i++){const v=await status();if(compatible(v))return v;await new Promise(r=>setTimeout(r,150));}
   throw Error('本机连接器启动失败');
 })();try{return await pending;}finally{pending=null;}}
 async function call(id:string,action:string){if(!['state','image'].includes(action))await ensure();const timeout=action==='login'?45000:action==='image'?30000:15000;const r=await fetch(`${base}/accounts/${encodeURIComponent(id)}/${action}`,{method:['state','image'].includes(action)?'GET':'POST',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(timeout)});const raw=await r.text();let v;try{v=JSON.parse(raw);}catch{throw Error(`本机连接器返回无效结果（HTTP ${r.status}）`);}if(!r.ok)throw Error(v.message);return v;}
 async function remove(id:string){await ensure();const r=await fetch(`${base}/accounts/${encodeURIComponent(id)}/remove`,{method:'POST',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(20000)});const raw=await r.text();if(!r.ok&&r.status!==404)throw Error(raw||`本机连接器清理失败（HTTP ${r.status}）`);return true;}
 return {status,ensure,login:(id:string)=>call(id,'login'),cancel:(id:string)=>call(id,'cancel'),state:(id:string)=>call(id,'state'),image:(id:string)=>call(id,'image'),remove};
}
