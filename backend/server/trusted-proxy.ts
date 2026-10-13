import type {Express} from 'express';
import type {IncomingMessage} from 'node:http';
import {isIP} from 'node:net';
function trustedProxy(address:string){
 const normalized=address.replace(/^::ffff:/,'');
 const configured=(process.env.TRUSTED_PROXY_IPS??'').split(',').map(ip=>ip.trim()).filter(Boolean);
 if(configured.some(ip=>!isIP(ip)))throw Error('TRUSTED_PROXY_IPS 只能包含明确的代理 IP 地址');
 return configured.includes(normalized)||(process.env.TRUST_LOOPBACK_PROXY==='1'&&['127.0.0.1','::1'].includes(normalized));
}
export function configureTrustedProxy(app:Express){
 if(process.env.TRUST_LOOPBACK_PROXY==='1'||process.env.TRUSTED_PROXY_IPS)app.set('trust proxy',trustedProxy);
}
// Only the configured ingress may supply HTTPS forwarding headers.
export function forwardedSecure(req:IncomingMessage){
 return trustedProxy(req.socket.remoteAddress??'')
  && req.headers['x-forwarded-proto']==='https';
}
export function forwardedLocal(req:IncomingMessage){
 if(process.env.NODE_ENV!=='development'||process.env.TRUST_LOCAL_PROXY_HTTP!=='1'||!trustedProxy(req.socket.remoteAddress??''))return false;
 try{
  const origin=new URL(process.env.CUSTOMER_PUBLIC_ORIGIN||process.env.PUBLIC_ORIGIN||'');
  return origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname)
   &&req.headers.host===origin.host&&req.headers['x-forwarded-proto']==='http';
 }catch{return false;}
}
