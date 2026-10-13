import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import WebSocket from 'ws';
import {normalizeCloudUrl} from './cloud-client.mjs';
import {validConnectorCommand} from '../shared/connector-protocol.mjs';
import {validXhsEvent} from '../shared/xhs-events.mjs';

export function startCloudChannel(device,{root,port,token,onStatus=()=>{},onError=()=>{},onWatch=()=>{},onEventAck=()=>{},WebSocketImpl=WebSocket,fetcher=fetch,reconnectMs=1000}={}){
 const base=normalizeCloudUrl(device.cloudUrl),url=base.replace(/^http/,'ws')+'/api/connector/channel';
 const epoch=randomUUID();
 const lease=()=>{if(root)writeFileSync(join(root,'device-lease.json'),JSON.stringify({epoch,until:Date.now()+45000}),{mode:0o600});};
 let stopped=false,socket,timer,failures=0;const active=new Map();
 const send=async(ws,message)=>{
   if(ws.readyState!==WebSocket.OPEN)throw Error('云端通道已断开');
   await new Promise((resolve,reject)=>ws.send(JSON.stringify(message),error=>error?reject(error):resolve()));
 };
 const run=async(ws,message)=>{
   const {id,method,path,body}=message;
   if(typeof id!=='string'||active.has(id)||active.size>=8||!validConnectorCommand(method,path,body))return send(ws,{type:'error',id});
   if(path==='/studio'&&body.apiBase!==base)return send(ws,{type:'error',id});
   const controller=new AbortController();active.set(id,controller);
   try{
     const response=await fetcher(`http://127.0.0.1:${port}`+path,{method,redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body!==undefined?JSON.stringify(body):undefined,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(path.includes('/media/')?120000:55000)])});
     await send(ws,{type:'head',id,status:response.status,contentType:response.headers.get('content-type')?.includes('application/octet-stream')?'application/octet-stream':'application/json'});
     let size=0;for await(const part of response.body??[]){size+=part.length;if(size>64*1024*1024)throw Error('本次媒体超过 64 MB 传输上限');for(let i=0;i<part.length;i+=48*1024)await send(ws,{type:'chunk',id,data:Buffer.from(part.subarray(i,i+48*1024)).toString('base64')});}
     await send(ws,{type:'end',id});
   }catch(error){if(ws.readyState===WebSocket.OPEN)await send(ws,{type:'error',id});onError(error);}
   finally{active.delete(id);}
 };
 const sendEvent=async event=>{if(!validXhsEvent(event))throw Error('事件格式无效');return send(socket,{type:'event',event});};
 const connect=()=>{
   if(stopped)return;
   const ws=new WebSocketImpl(url,{headers:{Authorization:'Bearer '+device.deviceToken},followRedirects:false,handshakeTimeout:15000,maxPayload:8*1024*1024});socket=ws;
   ws.on('ping',lease);
   ws.on('open',()=>{lease();failures=0;onStatus('connected');});
   ws.on('message',raw=>{lease();try{const m=JSON.parse(raw.toString());if(m.type==='cancel')active.get(m.id)?.abort();else if(m.type==='request')void run(ws,m).catch(onError);else if(m.type==='watch')void Promise.resolve(onWatch(m.subscriptions)).catch(onError);else if(m.type==='event-ack'&&typeof m.eventId==='string')onEventAck(m.eventId);}catch{ws.close(4002,'invalid request');}});
   ws.on('unexpected-response',(_req,res)=>{if([401,403,426].includes(res.statusCode))stopped=true;res.resume();ws.terminate();});
   ws.on('error',onError);
   ws.on('close',code=>{
     for(const controller of active.values())controller.abort();active.clear();onStatus('disconnected');
     if([4000,4001,4002].includes(code))stopped=true;
     if(!stopped){timer=setTimeout(connect,Math.min(60000,reconnectMs*2**Math.min(failures++,6)));timer.unref?.();}
   });
 };
 connect();const stop=()=>{stopped=true;clearTimeout(timer);for(const controller of active.values())controller.abort();socket?.close();};stop.sendEvent=sendEvent;return stop;
}
