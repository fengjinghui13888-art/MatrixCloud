import {randomBytes,timingSafeEqual} from 'node:crypto';
import {normalizeCloudUrl} from './cloud-client.mjs';

// The secret stays in the browser fragment (never sent to the cloud server).
// Only an explicit form POST from that cloud origin can bind this local process.
export function createOnboarding({cloudUrl,register,now=Date.now}){
 const origin=normalizeCloudUrl(cloudUrl),secret=randomBytes(32).toString('hex'),expires=now()+600000;
 let used=false,busy=false,failures=0;
 const respond=(res,status,message,hash='')=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",'Referrer-Policy':'no-referrer'});res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>矩阵云电脑连接</title><h1>${message}</h1><p><a href="${origin}/${hash}">返回工作台</a></p></html>`);};
 return {
  url:origin+'/#connectorSetup='+secret,
  async handle(req,res){
   const url=new URL(req.url,'http://127.0.0.1');
   if(url.pathname!=='/onboarding')return false;
   // Safari may omit Origin on a cross-origin form navigation when the
   // workbench's strict referrer policy is active. Accept that one browser
   // variation only when the Referer still proves the exact cloud origin.
   const originHeader=String(req.headers.origin||'').replace(/\/$/,'');
   let refererOrigin='';
   try{refererOrigin=new URL(String(req.headers.referer||'')).origin;}catch{}
   const sameCloudOrigin=originHeader===origin||(!originHeader&&refererOrigin===origin);
   // A top-level GET is used by Safari/Edge as the mixed-content-safe handoff
   // from the HTTPS workbench to the loopback connector. The nonce is still
   // required, and a supplied cross-site origin/referrer is rejected.
   const loopbackGet=req.method==='GET'&&(!originHeader&&!refererOrigin||sameCloudOrigin);
   if(req.method==='GET'&&!loopbackGet){respond(res,403,'请从工作台授权连接');return true;}
   if(req.method!=='GET'&&(req.method!=='POST'||!sameCloudOrigin||!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded'))){respond(res,403,'请从工作台授权连接');return true;}
   if(used||busy||now()>expires||failures>=5){respond(res,409,'连接授权已使用或过期，请重新启动连接器');return true;}
   let input;
   if(req.method==='GET')input=url.searchParams;
   else {let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2048){respond(res,413,'授权内容无效');return true;}}input=new URLSearchParams(body);}
   const value=Buffer.from(input.get('nonce')||''),expected=Buffer.from(secret);
   if(value.length!==expected.length||!timingSafeEqual(value,expected)||!/^\d{8}$/.test(input.get('code')||'')){failures++;respond(res,403,'连接授权无效，请重新启动连接器');return true;}
   // Recheck after the asynchronous body read to reject simultaneous submissions.
   if(used||busy||now()>expires){respond(res,409,'连接授权已使用或过期');return true;}
   busy=true;
   try{await register(input.get('code'));used=true;respond(res,200,'电脑已连接，可以返回工作台','#connectorComplete');}
   catch{failures++;respond(res,502,'连接未完成，请返回工作台重试');}
   finally{busy=false;}
   return true;
  },
 };
}
