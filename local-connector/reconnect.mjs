/**
 * Forward a second launcher's intent to the connector that already owns the
 * local port. This keeps the original browser profile and token alive.
 */
import {normalizeCloudUrl} from './cloud-client.mjs';

export function reconnectDecision({existing=null,targetCloudUrl='',pairingCode=''}={}){
 const cloudUrl=normalizeCloudUrl(targetCloudUrl||existing?.cloudUrl||'');
 const hasPairingCode=String(pairingCode).trim().length>0;
 if(!existing)return {action:hasPairingCode?'pair':'onboard',cloudUrl,requiresPairing:false};
 if(hasPairingCode)return {action:'pair',cloudUrl,requiresPairing:false};
 if(normalizeCloudUrl(existing.cloudUrl)===cloudUrl)return {action:'already-paired',cloudUrl,requiresPairing:false};
 return {action:'re-pair',cloudUrl,requiresPairing:true};
}

export async function forwardToExisting({port=47821,token,pairingCode='',cloudUrl='',deviceName='',onboard=false,fetcher=fetch}){
 const response=await fetcher(`http://127.0.0.1:${port}/reconnect`,{method:'POST',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({pairingCode,cloudUrl,deviceName,onboard})});
 const value=await response.json().catch(()=>({message:'正在运行的连接器没有返回可读状态'}));
 if(!response.ok){const error=Error(value?.message||`正在运行的连接器拒绝了请求（HTTP ${response.status}）`);error.status=response.status;throw error;}
 return value;
}
