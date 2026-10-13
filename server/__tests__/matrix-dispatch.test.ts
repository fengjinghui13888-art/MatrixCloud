import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import request from 'supertest';
import express from 'express';
import {studioRoutes} from '../studio-routes';
import {createStore} from '../store';
import {createStudio} from '../studio';
test('batch dispatch leaves approved tasks claimable by executor, never preclaims them',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'matrix-dispatch-'));const store=createStore(join(dir,'operations.sqlite'));
 for(const id of ['a','b'])store.addAccount({id,name:id,handle:id,profile:'local:'+id,avatar:'',state:'connected',followers:0,lastSyncedAt:new Date().toISOString()});
 const studio=createStudio(join(dir,'studio.sqlite'));let t=studio.create({accountId:'a',topic:'test',persona:'test',style:'test',imageCount:1,size:'1024x1536',requestId:'matrix-dispatch-123',confirmCharge:true}).task;
 t=studio.update(t.id,t.revision,{title:'test',body:'test',tags:[],images:['https://example.com/image.png'],status:'review'});
 // Exercise task lifecycle with an acknowledged dispatch. Device selection and
 // real transport are covered by customer-device-switch.test.ts.
 const app=express();app.use(express.json());studioRoutes(app,studio,{} as never,store,undefined,async(store,id)=>{const t=await store.get(id);await store.update(id,t.revision,{executionRunId:'11111111-1111-4111-8111-111111111111'});});
 const r=await request(app).post(`/api/studio/${t.id}/dispatch`).send({accountIds:['a','b']});
 expect(r.status).toBe(201);expect(r.body.tasks.map((t:any)=>t.status)).toEqual(['approved','approved']);
 for(const task of r.body.tasks){const claim=await request(app).post(`/api/studio/${task.id}/claim`).send({revision:task.revision,profile:'local:'+task.accountId,runId:task.executionRunId});expect(claim.status).toBe(200);expect(claim.body.status).toBe('filling');}
});
