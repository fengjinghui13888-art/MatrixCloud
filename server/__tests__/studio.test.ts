import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createGreyApp } from '../grey-app';
import { createStore } from '../store';
import {createStudio} from '../studio';

const auth='Bearer studio-test-token-longer-than-32-characters';
async function setup(imageFails=false,textFails=false){
 const dir=mkdtempSync(join(tmpdir(),'studio-test-'));
 const store=createStore(join(dir,'operations.sqlite'));
  store.importSnapshot({account:{id:'xhs:123',name:'Fixture',handle:'123',profile:'local:test',avatar:'',state:'connected',followers:0,lastSyncedAt:new Date().toISOString()},notes:[],comments:[]});
 const app=createGreyApp(store,auth.slice(7),{modelDataDir:dir,modelTransport:async(url,_headers,body:any)=>{
  if(url.endsWith('/images/generations')){if(imageFails)throw Error('模型服务返回 HTTP 402');expect(body.size).toBe('1024x1536');return {data:[{url:'https://example.com/fixture.png'}]};}
  if(textFails){textFails=false;throw Error('模型服务返回 HTTP 503');}
  return {choices:[{message:{content:JSON.stringify({title:'测试标题',body:'真实模型边界测试正文',tags:['测试'],imagePrompt:'test photograph'})}}]};
 }});
 await request(app).post('/api/models').set('Authorization',auth).send({label:'Test',protocol:'chat-completions',baseUrl:'https://text.example/v1',model:'text',imageModel:'image',apiKey:'fixture-key'});
 const create=()=>request(app).post('/api/studio/generate').set('Authorization',auth).send({accountId:'xhs:123',topic:'测试选题',persona:'真实分享',style:'简洁',imageCount:1,size:'1024x1536',requestId:'fixture-request-001',confirmCharge:true});
 return {app,create,studio:createStudio(join(dir,'studio.sqlite'))};
}
test('generation persists, review gates filling, editing invalidates approval, fill is not publication',async()=>{
 const {app,create,studio}=await setup();
 const made=await create();expect(made.status).toBe(201);let t=made.body;
 expect(t.status).toBe('review');expect(t.tags).toEqual(['测试']);
 const post=(action:string,body:object)=>request(app).post(`/api/studio/${t.id}/${action}`).set('Authorization',auth).send(body);
 expect((await post('claim',{revision:t.revision,profile:'local:test'})).status).toBe(409);
 t=(await post('review',{revision:t.revision,decision:'approve'})).body;
 expect(t.status).toBe('approved');
 t=(await post('edit',{revision:t.revision,title:'修改标题',body:t.body,tags:t.tags})).body;
 expect(t.status).toBe('review');
 t=(await post('review',{revision:t.revision,decision:'approve'})).body;
 t=studio.update(t.id,t.revision,{executionRunId:'11111111-1111-4111-8111-111111111111'});
 t=(await post('claim',{revision:t.revision,profile:'local:test',runId:t.executionRunId})).body;
 expect(t.status).toBe('filling');
 expect((await post('claim',{revision:t.revision,profile:'local:test'})).status).toBe(409);
 t=(await post('receipt',{revision:t.revision,status:'filled',runId:t.executionRunId,draftId:'verified-draft-1',accountId:'xhs:123',title:t.title,body:t.body,tags:t.tags,imageCount:1,message:'测试环境字段回读'})).body;
 expect(t.status).toBe('filled');
 expect((await post('retry',{revision:t.revision,checkedNotPublished:true})).status).toBe(409);
 const linked=await post('link',{revision:t.revision,url:'https://www.xiaohongshu.com/explore/0123456789abcdef01234567'});expect(linked.status,JSON.stringify(linked.body)).toBe(200);t=linked.body;
 expect(t.status).toBe('pending_confirmation');
 expect((await create()).body.id).toBe(t.id);
});
test('manual text continuation retains the original task and rejects stale retries',async()=>{
 const {app,create}=await setup(false,true);const failed=(await create()).body;
 expect(failed.status).toBe('generation_failed');expect(failed.message).toContain('文案生成失败');expect(failed.body).toBe('');
 const post=()=>request(app).post(`/api/studio/${failed.id}/resume`).set('Authorization',auth).send({revision:failed.revision,confirmCharge:true});
 const done=(await post()).body;expect(done.id).toBe(failed.id);expect(done.status).toBe('review');expect(done.images).toHaveLength(1);
 expect((await post()).status).toBe(409);
 expect((await request(app).get('/api/studio').set('Authorization',auth)).body).toHaveLength(1);
});
test('async generation acknowledges a task before a slow provider returns',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'studio-async-'));const store=createStore(join(dir,'operations.sqlite'));
 store.importSnapshot({account:{id:'a',name:'Test',handle:'a',profile:'local:a',avatar:'',state:'connected',followers:0,lastSyncedAt:new Date().toISOString()},notes:[],comments:[]});
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
 const app=createGreyApp(store,auth.slice(7),{modelDataDir:dir,modelTransport:async(url)=>{if(url.endsWith('/images/generations'))return {data:[{url:'https://example.com/a.png'}]};await gate;return {choices:[{message:{content:JSON.stringify({title:'标题',body:'正文',tags:[],imagePrompt:'photo'})}}]};}});
 await request(app).post('/api/models').set('Authorization',auth).send({label:'Test',protocol:'chat-completions',baseUrl:'https://example.com',model:'text',imageModel:'image',apiKey:'test'});
 const response=await request(app).post('/api/studio/generate?async=1').set('Authorization',auth).send({accountId:'a',topic:'topic',persona:'',style:'',imageCount:1,size:'1024x1024',requestId:'async-fixture-001',confirmCharge:true});
 expect(response.status).toBe(202);expect(response.body.status).toBe('generating');release();
 await vi.waitFor(async()=>{expect((await request(app).get('/api/studio/'+response.body.id).set('Authorization',auth)).body.status).toBe('review');});
});
test('image failure preserves generated copy and reports cause, no fake images',async()=>{
 const {app,create}=await setup(true);const result=await create();
 expect(result.status).toBe(201);expect(result.body.status).toBe('generation_failed');
 expect(result.body.body).toBe('真实模型边界测试正文');expect(result.body.images).toEqual([]);
 expect(result.body.message).toContain('HTTP 402');
 const list=await request(app).get('/api/studio').set('Authorization',auth);
 expect(list.body[0].id).toBe(result.body.id);
});
test('one task generates twelve images and fresh requests retain original generation behavior',async()=>{
 const {app}=await setup();const brief={accountId:'xhs:123',topic:'十二张配图验收',persona:'真实分享',style:'简洁',imageCount:12,size:'1024x1536',requestId:'twelve-images-0001',confirmCharge:true};
 const generate=(body:object)=>request(app).post('/api/studio/generate').set('Authorization',auth).send(body);
 const before=await request(app).get('/api/models').set('Authorization',auth);
 const a=await generate(brief);expect(a.status).toBe(201);expect(a.body.status).toBe('review');expect(a.body.images).toHaveLength(12);
 const repeat=await generate(brief);expect(repeat.body.id).toBe(a.body.id);
 const fresh=await generate({...brief,requestId:'twelve-images-0002'});expect(fresh.body.id).not.toBe(a.body.id);expect(fresh.body.images).toHaveLength(12);
 expect((await request(app).get('/api/models').set('Authorization',auth)).body).toEqual(before.body);
 expect((await generate({...brief,requestId:'twelve-images-0003',imageCount:13})).status).toBe(409);
});
