import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createStore } from '../store';
import { createGreyApp } from '../grey-app';

test('rich imports preserve media and private messages across reloads and partial sync without crossing accounts',async()=>{
  const file=join(mkdtempSync(join(tmpdir(),'rich-sync-')),'ops.sqlite');
  const app=createGreyApp(createStore(file),'fixture-token-at-least-32-characters');
  const call=(body:object)=>request(app).post('/api/import').set('Authorization','Bearer fixture-token-at-least-32-characters').send(body);
  const note={id:'n1',accountId:'a1',title:'Test video',summary:'Full text',cover:null,url:null,publishedAt:'2026-09-07',metrics:{likes:null,collects:null,comments:null,shares:null}};
  const body={account:{id:'a1',name:'Test account',handle:'fixture',profile:'test',avatar:'',state:'connected',followers:0,lastSyncedAt:'2026-09-07T00:00:00Z'},notes:[{...note,mediaType:'video',images:['https://example.com/one.jpg'],videoUrl:'https://example.com/video.mp4'}],comments:[],messages:[{id:'m1',accountId:'a1',conversationId:'c1',author:'Test sender',body:'Private test text',createdAt:'2026-09-07',direction:'incoming'}]};
  expect((await call(body)).status).toBe(200);
  expect(createStore(file).listNotes()[0]).toMatchObject({mediaType:'video',videoUrl:'https://example.com/video.mp4',images:['https://example.com/one.jpg']});
  expect((await call({...body,notes:[note],messages:undefined})).status).toBe(200);
  expect(createStore(file).listNotes()[0]).toHaveProperty('videoUrl','https://example.com/video.mp4');
  const data=await request(app).get('/api/operations').set('Authorization','Bearer fixture-token-at-least-32-characters');
  expect(data.body.messages).toEqual([body.messages[0]]);
  expect((await call({...body,messages:[{...body.messages[0],accountId:'another'}]})).status).toBe(400);
  expect((await call({...body,notes:[{...body.notes[0],videoUrl:'javascript:alert(1)'}]})).status).toBe(400);
  expect((await request(app).get('/api/operations')).status).toBe(401);
});
