import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import request from 'supertest';import {createGreyApp} from '../grey-app';import {createStore} from '../store';
test('customer import cannot forge a connector session binding',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'import-binding-'));const token='audit-token-more-than-32-characters';const app=createGreyApp(createStore(join(dir,'ops.sqlite')),token,{authDataDir:dir});
 const post=(p:string)=>request(app).post('/api/'+p).set('Host','127.0.0.1').set('Origin','http://127.0.0.1');
 await post('auth/setup').send({username:'owner',password:'audit-password-123'});const reg=await post('auth/register').send({username:'customer',password:'audit-password-123'});const cookie=reg.headers['set-cookie'][0].split(';')[0];
 const r=await post('import').set('Cookie',cookie).send({account:{id:'a',handle:'123',name:'A',profile:'local:another-customer-session',avatar:'',state:'connected',followers:0,lastSyncedAt:new Date().toISOString()},notes:[],comments:[]});
 expect(r.status).toBe(403);expect((await request(app).get('/api/accounts').set('Cookie',cookie)).body).toEqual([]);
});
