// @vitest-environment node
import {it,expect,vi} from 'vitest';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createOnboarding} from '../../../local-connector/onboarding.mjs';

async function fixture(options,run){
 const onboarding=createOnboarding({cloudUrl:'https://cloud.test',...options});
 const server=createServer(async(req,res)=>{if(!await onboarding.handle(req,res)){res.writeHead(404);res.end();}}).listen(0,'127.0.0.1');
 await once(server,'listening');
 const nonce=new URL(onboarding.url).hash.split('=')[1];
 const send=(body={},origin='https://cloud.test',extraHeaders={})=>fetch(`http://127.0.0.1:${server.address().port}/onboarding`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',...extraHeaders},body:new URLSearchParams({nonce,code:'12345678',...body})});
 const sendGet=(query={},extraHeaders={})=>fetch(`http://127.0.0.1:${server.address().port}/onboarding?${new URLSearchParams({nonce,code:'12345678',...query})}`,{headers:extraHeaders});
 try{await run(send,onboarding,sendGet);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
it('requires exact cloud origin and nonce, registers once and rejects replay',async()=>{
 const register=vi.fn();
 await fixture({register},async(send,onboarding)=>{
  expect(new URL(onboarding.url).search).toBe('');
  expect((await send({},'https://other.test')).status).toBe(403);
  expect((await send({nonce:'wrong'})).status).toBe(403);
  expect(register).not.toHaveBeenCalled();
  expect((await send()).status).toBe(200);
  expect((await send()).status).toBe(409);
  expect(register).toHaveBeenCalledTimes(1);expect(register).toHaveBeenCalledWith('12345678');
 });
});
it('accepts a nonce-protected top-level GET handoff for Safari and registers once',async()=>{
 const register=vi.fn();
 await fixture({register},async(_send,_onboarding,sendGet)=>{
  const response=await sendGet();
  expect(response.status).toBe(200);
  expect(register).toHaveBeenCalledTimes(1);
  expect(await response.text()).toContain('connectorComplete');
 });
});
it('accepts Safari-style missing Origin only with an exact cloud Referer',async()=>{
 const register=vi.fn();
 await fixture({register},async(send,onboarding)=>{
  const response=await send({},'',{Referer:'https://cloud.test/account-matrix'});
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('https://cloud.test/#connectorComplete');
 });
});
it('does not accept a missing Origin from another Referer',async()=>{
 const register=vi.fn();
 await fixture({register},async(send)=>{
  expect((await send({},'',{Referer:'https://evil.test/account-matrix'})).status).toBe(403);
  expect(register).not.toHaveBeenCalled();
 });
});
it('rejects expired authorization without changing stored credentials',async()=>{
 let time=0;const register=vi.fn();
 await fixture({register,now:()=>time},async send=>{time=600001;expect((await send()).status).toBe(409);expect(register).not.toHaveBeenCalled();});
});
it('prevents concurrent registration during an in-flight attempt',async()=>{
 let finish;const register=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));
 await fixture({register},async send=>{
  const first=send();await vi.waitFor(()=>expect(register).toHaveBeenCalledTimes(1));
  expect((await send()).status).toBe(409);finish();expect((await first).status).toBe(200);
 });
});
