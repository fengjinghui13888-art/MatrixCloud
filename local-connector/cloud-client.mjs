import {readFile,writeFile,mkdir,rename,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {platform,hostname} from 'node:os';
import {randomUUID} from 'node:crypto';

export function normalizeCloudUrl(value){
  let url;try{url=new URL(value);}catch{throw Error('云端地址无效');}
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!(local&&url.protocol==='http:'))||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('请使用 HTTPS 网站地址（本机调试可使用 HTTP）');
  return url.origin;
}
// A persisted credential is bound to the origin that issued it. Callers must
// discard it before using a configured origin that differs from that origin;
// the only way to obtain a credential for the new origin is a fresh pairing.
export function resolveCloudTarget({device=null,cloudUrl='' }={}){
  const target=cloudUrl?normalizeCloudUrl(cloudUrl):device?.cloudUrl||'';
  if(!target)return {cloudUrl:'',device:null,requiresPairing:false};
  if(!device)return {cloudUrl:target,device:null,requiresPairing:false};
  const persisted=normalizeCloudUrl(device.cloudUrl);
  if(persisted===target)return {cloudUrl:target,device,requiresPairing:false};
  return {cloudUrl:target,device:null,requiresPairing:true};
}
export async function cloudRequest(device,path,{fetcher=fetch,body={},timeoutMs=15000,signal}={}){
  const base=normalizeCloudUrl(device.cloudUrl);
  const response=await fetcher(base+path,{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),headers:{'Content-Type':'application/json',...(device.deviceToken?{Authorization:'Bearer '+device.deviceToken}:{})},body:JSON.stringify(body)});
  const value=await response.json().catch(()=>null);
  if(!response.ok){const error=Error(value?.message||`云端连接失败（HTTP ${response.status}）`);error.status=response.status;throw error;}
  if(!value||typeof value!=='object')throw Error('云端返回了无效结果');
  return value;
}
export async function registerCloudConnector({cloudUrl,pairingCode,root,deviceName=hostname(),version='4.0.0',fetcher=fetch}){
  const base=normalizeCloudUrl(cloudUrl);
  if(!/^\d{8}$/.test(pairingCode))throw Error('请输入 8 位配对码');
  // Check local persistence before consuming the one-use code.
  await mkdir(root,{recursive:true,mode:0o700});
  const temp=join(root,'.cloud-device-'+randomUUID());
  await writeFile(temp,'',{mode:0o600,flag:'wx'});
  try{
    const result=await cloudRequest({cloudUrl:base},'/api/connector/register',{fetcher,body:{code:pairingCode,deviceName,platform:platform(),version}});
    if(typeof result.deviceId!=='string'||!/^[a-f0-9]{64}$/.test(result.deviceToken)||typeof result.workspace!=='string')throw Error('云端返回了无效配对凭证，请生成新码重试');
    await writeFile(temp,JSON.stringify({cloudUrl:base,deviceId:result.deviceId,deviceToken:result.deviceToken,workspace:result.workspace,createdAt:new Date().toISOString()}),{mode:0o600});
    await rename(temp,join(root,'cloud-device.json'));await chmod(join(root,'cloud-device.json'),0o600);
    return {deviceId:result.deviceId,workspace:result.workspace,heartbeatIntervalSeconds:30};
  }finally{await rm(temp,{force:true});}
}
export async function loadCloudDevice(root){
  let raw;try{raw=await readFile(join(root,'cloud-device.json'),'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
  let value;try{value=JSON.parse(raw);}catch{throw Error('本机配对文件损坏，请重新配对');}
  if(!value||typeof value.deviceId!=='string'||!/^[a-f0-9]{64}$/.test(value.deviceToken)||typeof value.workspace!=='string')throw Error('本机配对文件无效，请重新配对');
  value.cloudUrl=normalizeCloudUrl(value.cloudUrl);return value;
}
export async function heartbeatCloudConnector(device,options={}){
  if(!device?.deviceToken)throw Error('本机连接器尚未完成云端配对');
  return (await cloudRequest(device,'/api/connector/heartbeat',options)).device;
}
export function startCloudHeartbeat(device,{intervalMs=30000,onStatus=()=>{},onError=()=>{},heartbeat=heartbeatCloudConnector,setTimeoutFn=setTimeout,clearTimeoutFn=clearTimeout}={}){
  let stopped=false,timer,failures=0;const controller=new AbortController();
  const run=async()=>{
    if(stopped)return;
    try{const status=await heartbeat(device,{signal:controller.signal});if(!stopped)onStatus(status);failures=0;}
    catch(error){if(stopped)return;onError(error);if([401,403].includes(error.status)){stopped=true;return;}failures++;}
    if(!stopped){timer=setTimeoutFn(run,Math.min(120000,intervalMs*2**Math.min(failures,3)));timer?.unref?.();}
  };
  void run();return ()=>{stopped=true;controller.abort();if(timer!==undefined)clearTimeoutFn(timer);};
}
