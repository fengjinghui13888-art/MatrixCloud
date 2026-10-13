// @vitest-environment node
import {it,expect} from 'vitest';import {spawn} from 'node:child_process';import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
it('starts from an empty data directory and creates its private token without launching Chrome',async()=>{
 const root=await mkdtemp(join(tmpdir(),'connector-fresh-'));
 const port=47820+Math.floor(Math.random()*200);
 const child=spawn(process.execPath,['local-connector/connector.mjs','--data-dir',root,'--port',String(port)],{stdio:['ignore','pipe','pipe']});
 try{
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup timeout')),10000);child.stdout.on('data',data=>{if(data.toString().includes('已启动')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('connector exited '+code));});});
   expect(await readFile(join(root,'connector-token'),'utf8')).toMatch(/^[a-f0-9]{64}$/);if(process.platform!=='win32')expect((await stat(join(root,'connector-token'))).mode&0o777).toBe(0o600); // POSIX modes do not represent Windows ACLs.
   const landing=await new Promise((resolve,reject)=>{const req=httpRequest({host:'127.0.0.1',port,path:'/'},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end();});
   expect(landing).toMatchObject({status:200});expect(landing.body).toContain('返回矩阵云工作台');
   const readJson=async(path,token)=>new Promise((resolve,reject)=>{const req=httpRequest({host:'127.0.0.1',port,path,headers:token?{Authorization:'Bearer '+token}:{}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(body)});}catch(error){reject(error);}});});req.on('error',reject);req.end();});
   const health=await readJson('/health');expect(health.status).toBe(200);expect(health.body.capabilities).toContain('event-sync');
   expect((await readJson('/verify')).status).toBe(401);
   const verified=await readJson('/verify',(await readFile(join(root,'connector-token'),'utf8')).trim());
   expect(verified.status).toBe(200);expect(verified.body.capabilities).toContain('event-sync');
 }finally{child.kill();await new Promise(r=>child.once('exit',r));await rm(root,{recursive:true,force:true});}
});
