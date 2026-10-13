import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import sharp from 'sharp';
import { createGreyApp } from '../grey-app';
import { createStore } from '../store';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const local=(r:any)=>r.set('Host','127.0.0.1').set('Origin','http://127.0.0.1');
test('thumbnail is small, cached with authenticated revalidation, and inaccessible after deletion',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'template-thumb-')),token='library-test-token-at-least-32-characters';
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),token,{authDataDir:dir});
  const bytes=await sharp({create:{width:2560,height:1440,channels:3,background:'#aabbcc'}}).jpeg().toBuffer();
  const uploaded=await request(app).post('/api/templates/upload').set('Authorization','Bearer '+token).send({fileName:'photo.jpg',data:'data:image/jpeg;base64,'+bytes.toString('base64')});
  const path=uploaded.body.item.images[0]+'?size=thumb';
  const first=await request(app).get(path).set('Authorization','Bearer '+token);
  expect(first.status).toBe(200);expect(first.headers['content-type']).toContain('image/webp');
  expect((await sharp(first.body).metadata()).width).toBe(480);expect(first.body.length).toBeLessThan(bytes.length);
  expect(first.headers['cache-control']).toBe('private, no-cache');
  expect((await request(app).get(path).set('Authorization','Bearer '+token).set('If-None-Match',first.headers.etag)).status).toBe(304);
  expect((await request(app).get(path).set('If-None-Match',first.headers.etag)).status).toBe(401);
  await request(app).post('/api/templates/bulk-delete').set('Authorization','Bearer '+token).send({ids:[uploaded.body.item.id]});
  expect((await request(app).get(path).set('Authorization','Bearer '+token).set('If-None-Match',first.headers.etag)).status).toBe(404);
});
test('customer uploads persist immediately, deduplicate, isolate tenants, and delete without touching other tenants',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'personal-library-'));
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),'library-test-token-at-least-32-characters',{authDataDir:dir});
  const owner=await local(request(app).post('/api/auth/setup')).send({username:'owner',password:'test-password-123'});
  const other=await local(request(app).post('/api/auth/register')).send({username:'customer',password:'test-password-123'});
  const cookie=owner.headers['set-cookie'][0].split(';')[0],otherCookie=other.headers['set-cookie'][0].split(';')[0];
  const data={fileName:'往期素材 中文（01）.png',data:'data:image/png;base64,'+png};
  expect((await request(app).post('/api/templates/upload').send(data)).status).toBe(401);
  expect((await request(app).post('/api/templates/upload').set('Cookie',cookie).set('Origin','https://evil.example').send(data)).status).toBe(403);
  const upload=await local(request(app).post('/api/templates/upload')).set('Cookie',cookie).send(data);
  expect(upload.status).toBe(201);expect(upload.body.item.name).toContain('中文');
  expect((await local(request(app).post('/api/templates/upload')).set('Cookie',cookie).send(data)).body.duplicate).toBe(true);
  const path=upload.body.item.images[0];
  expect((await request(app).get(path).set('Cookie',cookie)).status).toBe(200);
  expect((await request(app).get(path).set('Cookie',otherCookie)).status).toBe(404);
  expect((await request(app).get('/api/templates/mine').set('Cookie',cookie)).body.items).toHaveLength(1);
  expect((await request(app).get('/api/templates/mine').set('Cookie',otherCookie)).body.items).toEqual([]);
  const otherUpload=await local(request(app).post('/api/templates/upload')).set('Cookie',otherCookie).send(data);
  expect(otherUpload.status).toBe(201);
  expect((await local(request(app).post('/api/templates/bulk-delete')).set('Cookie',otherCookie).send({ids:[upload.body.item.id]})).status).toBe(404);
  expect((await local(request(app).post('/api/templates/bulk-delete')).set('Cookie',cookie).send({ids:[upload.body.item.id]})).status).toBe(200);
  expect((await request(app).get(path).set('Cookie',cookie)).status).toBe(404);
  expect((await request(app).get(path).set('Cookie',otherCookie)).status).toBe(200);
  const reopened=createGreyApp(createStore(join(dir,'ops.sqlite')),'library-test-token-at-least-32-characters',{authDataDir:dir});
  expect((await request(reopened).get('/api/templates/mine').set('Cookie',otherCookie)).body.items).toHaveLength(1);
});
test('rejects fake images and oversize images with a specific client error',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'personal-library-')),token='library-test-token-at-least-32-characters';
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),token,{authDataDir:dir});
  const post=(data:string)=>request(app).post('/api/templates/upload').set('Authorization','Bearer '+token).send({fileName:'test.png',data});
  expect((await post('data:image/png;base64,'+Buffer.from('<html>bad</html>').toString('base64'))).status).toBe(400);
  expect((await post('data:image/png;base64,'+Buffer.alloc(9*1024*1024).toString('base64'))).status).toBe(413);
});
test('reference generation sends the actual uploaded image, not just its name; persists returned image and preserves copy input',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'personal-reference-')),token='library-test-token-at-least-32-characters';
  const store=createStore(join(dir,'ops.sqlite'));
  store.importSnapshot({account:{id:'account',name:'Test',handle:'123',profile:'local:test',avatar:'',state:'connected',followers:0,lastSyncedAt:new Date().toISOString()},notes:[],comments:[]});
  let edits=0;
  const app=createGreyApp(store,token,{authDataDir:dir,modelDataDir:dir,modelTransport:async(url,headers,body:any)=>{
    if(url.endsWith('/images/edits')){edits++;expect(Buffer.isBuffer(body)).toBe(true);expect(body.includes(Buffer.from(png,'base64'))).toBe(true);expect(headers['Content-Type']).toContain('multipart/form-data');return {data:[{b64_json:png}]};}
    expect(JSON.stringify(body)).not.toContain('往期素材');return {choices:[{message:{content:JSON.stringify({title:'独立生成的文案',body:'只依据用户选题生成。',tags:[],imagePrompt:'A desk'})}}]};
  }});
  const post=(path:string,data:object)=>request(app).post('/api/'+path).set('Authorization','Bearer '+token).send(data);
  const item=(await post('templates/upload',{fileName:'往期素材.png',data:'data:image/png;base64,'+png})).body.item;
  await post('models',{label:'Test',protocol:'chat-completions',baseUrl:'https://provider.example/v1',model:'text',imageModel:'gpt-image-1',apiKey:'test-key'});
  const brief={accountId:'account',topic:'桌面整理',persona:'',style:'简洁',imageCount:1,size:'1024x1024',requestId:'reference-fixture-001',confirmCharge:true,imageMode:'reference',templateIds:[item.id],strength:0.6};
  const made=await post('studio/generate',brief);
  expect(made.status).toBe(201);expect(made.body.status).toBe('review');expect(edits).toBe(1);
  expect(made.body.images[0]).toMatch(/^\/api\/templates\/media\//);
  expect((await post('studio/generate',brief)).body.id).toBe(made.body.id);expect(edits).toBe(1);
  expect((await post('studio/generate',{...brief,strength:0.7})).status).toBe(409);
});
