import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createStore } from '../store';
import { createGreyApp } from '../grey-app';

test('account discovery and scoped overview keep separate accounts isolated and reject unknown scope',async()=>{
  const store=createStore(join(mkdtempSync(join(tmpdir(),'account-scope-')),'ops.sqlite'));
  for(const id of ['a','b'])store.importSnapshot({account:{id,name:'同名账号',handle:id,avatar:'',profile:id,state:'connected',followers:1,lastSyncedAt:new Date().toISOString()},notes:[{id:'note-'+id,accountId:id,title:id,summary:null,cover:null,url:null,publishedAt:'2026-09-01',metrics:{likes:null,collects:null,comments:null,shares:null}}],comments:[]});
  const app=createGreyApp(store,'account-scope-token-at-least-32-characters');
  const auth={Authorization:'Bearer account-scope-token-at-least-32-characters'};
  const accounts=await request(app).get('/api/accounts').set(auth);
  expect(accounts.status).toBe(200);expect(accounts.body).toHaveLength(2);
  const scoped=await request(app).get('/api/operations?accountId=b').set(auth);
  expect(scoped.body.accounts.map((a:{id:string})=>a.id)).toEqual(['b']);
  expect(scoped.body.notes.map((n:{id:string})=>n.id)).toEqual(['note-b']);
  expect((await request(app).get('/api/operations?accountId=missing').set(auth)).status).toBe(404);
});
