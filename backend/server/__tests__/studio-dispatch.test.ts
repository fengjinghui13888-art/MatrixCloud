// @vitest-environment node
import express from 'express';
import request from 'supertest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {createStudio} from '../studio';
import {studioRoutes} from '../studio-routes';
import {isStudioExecutorRunning,recoverStalledExecutions,finishStudioExecution} from '../studio-execution';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
function setup(){
 vi.stubEnv('LOCAL_CONNECTOR_URL','http://127.0.0.1:47822');
 vi.stubEnv('LOCAL_CONNECTOR_TOKEN','connector-fixture');
 vi.stubEnv('STUDIO_TOKEN','workspace-fixture');
 vi.stubEnv('STUDIO_CALLBACK_URL','http://127.0.0.1:47824');
 const fetcher=vi.fn(async(_url:string,_init?:RequestInit)=>new Response(JSON.stringify({ok:true,status:'running'}),{status:202}));vi.stubGlobal('fetch',fetcher);
 const studio=createStudio(join(mkdtempSync(join(tmpdir(),'studio-dispatch-')),'studio.sqlite'));
 let task=studio.create({accountId:'a',topic:'t',persona:'p',style:'s',imageCount:1,size:'1024x1536',requestId:'fixture-dispatch',confirmCharge:true}).task;
 task=studio.update(task.id,task.revision,{status:'approved',title:'审核标题',body:'审核正文',tags:[],images:['https://example.com/image.png']});
 const app=express();app.use(express.json());studioRoutes(app,studio,{} as never,{listAccounts:()=>[{id:'a',profile:'local:fixture',name:'fixture',handle:'1234'}]} as never);
 return {app,studio,task,fetcher};
}
it('remote acknowledgement never preclaims a task or invalidates the device claim; repeated clicks dispatch once',async()=>{
 const {app,studio,task,fetcher}=setup();
 const first=await request(app).post(`/api/studio/${task.id}/execute`);
 expect(first.status).toBe(200);
 await new Promise(r=>setTimeout(r,20));
 expect(studio.get(task.id).status).toBe('approved');
 const second=await request(app).post(`/api/studio/${task.id}/execute`);
 expect(second.body.revision).toBe(first.body.revision);
 expect(fetcher).toHaveBeenCalledTimes(1);
 expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({apiBase:'http://127.0.0.1:47824',profile:'local:fixture'});
 const claim=await request(app).post(`/api/studio/${task.id}/claim`).send({revision:first.body.revision,profile:'local:fixture',runId:first.body.executionRunId});
 expect(claim.status).toBe(200);
 const receipt=await request(app).post(`/api/studio/${task.id}/receipt`).send({revision:claim.body.revision,status:'filled',runId:studio.get(task.id).executionRunId,draftId:'verified-draft-1',accountId:'a',title:task.title,body:task.body,tags:[],imageCount:1,message:'草稿核对一致'});
 expect(receipt.status).toBe(200);
 expect(isStudioExecutorRunning(task.id)).toBe(false);
});
it('retry dispatches immediately instead of only changing a badge',async()=>{
 const {app,studio,task,fetcher}=setup();
 const blocked=studio.update(task.id,task.revision,{status:'blocked'});
 const result=await request(app).post(`/api/studio/${task.id}/retry`).send({revision:blocked.revision,checkedNotPublished:true});
 expect(result.status).toBe(200);expect(fetcher).toHaveBeenCalledTimes(1);
 studio.update(task.id,studio.get(task.id).revision,{status:'blocked'});await recoverStalledExecutions(studio);
});
it('persisted duration includes time before claim',async()=>{
 const {app,studio,task}=setup();
 const current=studio.update(task.id,task.revision,{status:'filling',executionRunId:'11111111-1111-4111-8111-111111111111',profile:'local:fixture',executionStartedAt:new Date(Date.now()-13000).toISOString()});
 const receipt=await request(app).post(`/api/studio/${task.id}/receipt`).send({revision:current.revision,status:'filled',runId:studio.get(task.id).executionRunId,draftId:'verified-draft-1',accountId:'a',title:task.title,body:task.body,tags:[],imageCount:1,message:'内容与草稿箱核对一致'});
 expect(receipt.status).toBe(200);expect(receipt.body.executionElapsedMs).toBeGreaterThanOrEqual(13000);
});
it('approval automatically dispatches exactly once without another execute click',async()=>{
 const {app,studio,task,fetcher}=setup();
 const pending=studio.update(task.id,task.revision,{status:'review'});
 const approve=()=>request(app).post(`/api/studio/${task.id}/review`).send({revision:pending.revision,decision:'approve'});
 try{
  const first=await approve();expect(first.status).toBe(200);
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
  expect(first.body.executionRunId).toBeTruthy();
  expect((await approve()).status).toBe(409);expect(fetcher).toHaveBeenCalledTimes(1);
 }finally{finishStudioExecution(task.id);}
});
it('only a matching pre-upload failure receipt unlocks a safe retry',async()=>{
 const {app,studio,task}=setup();
 let current=studio.update(task.id,task.revision,{status:'filling',profile:'local:fixture',executionRunId:'11111111-1111-4111-8111-111111111111',executionStartedAt:new Date().toISOString()});
 const receipt=(body:object)=>request(app).post(`/api/studio/${task.id}/receipt`).send({revision:current.revision,status:'blocked',message:'创作页被占用',retrySafe:true,...body});
 expect((await receipt({runId:'22222222-2222-4222-8222-222222222222'})).status).toBe(409);
 const safe=await receipt({runId:current.executionRunId});expect(safe.status).toBe(200);expect(safe.body.executionStartedAt).toBeUndefined();
 current=studio.update(task.id,safe.body.revision,{status:'filling',executionStartedAt:new Date().toISOString()});
 const unknown=await receipt({runId:current.executionRunId,retrySafe:false});expect(unknown.status).toBe(200);expect(unknown.body.executionStartedAt).toBeTruthy();
});
it('recovers an old pre-upload page failure without unlocking uncertain uploads',async()=>{
 const {app,studio,task,fetcher}=setup();
 let current=studio.update(task.id,task.revision,{status:'blocked',executionStartedAt:'2026-09-17T03:43:11.718Z',message:'连接/页面检查失败：当前创作页已有未保存内容，已保留原页面；请核对后再同步'});
 const response=await request(app).post(`/api/studio/${task.id}/retry`).send({revision:current.revision,checkedNotPublished:true});
 expect(response.status).toBe(200);expect(response.body.executionRunId).toBeTruthy();expect(fetcher).toHaveBeenCalledTimes(1);
 finishStudioExecution(task.id);
 current=studio.update(task.id,studio.get(task.id).revision,{status:'blocked',message:'图片上传失败：连接中断'});
 expect((await request(app).post(`/api/studio/${task.id}/retry`).send({revision:current.revision,checkedNotPublished:true})).status).toBe(409);
 expect(fetcher).toHaveBeenCalledTimes(1);
});
it('a synchronous dispatch rejection does not permanently occupy an approved task',async()=>{
 const {studio,task}=setup();
 const app=express();app.use(express.json());
 studioRoutes(app,studio,{} as never,{listAccounts:()=>[{id:'a',profile:'local:fixture',name:'fixture',handle:'1234'}]} as never,undefined,async()=>{throw Error('执行设备尚未配对');});
 const response=await request(app).post(`/api/studio/${task.id}/execute`);
 expect(response.status).toBe(409);
 const current=studio.get(task.id);expect(current.status).toBe('approved');expect(current.executionStartedAt).toBeUndefined();expect(current.executionRunId).toBeUndefined();
});
