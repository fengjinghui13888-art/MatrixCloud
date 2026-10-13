import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import request from 'supertest';
import { createGreyApp } from '../grey-app';
import { createStore } from '../store';
import { runSqlite } from '../sqlite-client';

test('first administrator can log in, retain a server session and log out without changing MCP auth',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'account-login-'));
  const token='fixture-mcp-token-more-than-32-characters';
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),token,{authDataDir:dir});
  const local=(r:any)=>r.set('Host','127.0.0.1').set('Origin','http://127.0.0.1');
  expect((await request(app).get('/api/auth/status')).body.configured).toBe(false);
  const setup=await local(request(app).post('/api/auth/setup')).send({username:'owner',password:'fixture-password-123'});
  expect(setup.status).toBe(201);
  expect(setup.text).not.toContain('fixture-password-123');
  expect((await local(request(app).post('/api/auth/setup')).send({username:'attacker',password:'fixture-password-123'})).status).toBe(409);
  expect((await local(request(app).post('/api/auth/login')).send({username:'owner',password:'wrong-password'})).status).toBe(401);
  const login=await local(request(app).post('/api/auth/login')).send({username:'owner',password:'fixture-password-123'});
  expect(login.status).toBe(200);
  const cookie=login.headers['set-cookie'][0];
  expect(cookie).toContain('HttpOnly');expect(cookie).toContain('SameSite=Strict');expect(cookie).not.toContain(token);
  const session=cookie.split(';')[0];
  const reopened=createGreyApp(createStore(join(dir,'ops.sqlite')),token,{authDataDir:dir});
  expect((await request(reopened).get('/api/operations').set('Cookie',session)).status).toBe(200);
  expect((await request(reopened).get('/api/auth/session').set('Cookie',session)).body.username).toBe('owner');
  expect((await request(reopened).post('/mcp').set('Cookie',session).send({})).status).toBe(401);
  expect((await request(reopened).post('/api/leads').set('Cookie',session).set('Origin','https://evil.example').send({})).status).toBe(403);
  expect((await local(request(reopened).post('/api/auth/logout')).set('Cookie',session).send({})).status).toBe(200);
  expect((await request(reopened).get('/api/operations').set('Cookie',session)).status).toBe(401);
  expect((await request(reopened).get('/api/operations').set('Authorization','Bearer '+token)).status).toBe(200);
});

test('remote host cannot claim unconfigured workspace and login attempts are limited',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'login-limit-'));
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),'fixture-token-more-than-32-characters',{authDataDir:dir});
  expect((await request(app).post('/api/auth/setup').set('Host','public.example').set('Origin','http://public.example').send({username:'owner',password:'fixture-password-123'})).status).toBe(403);
  for(let i=0;i<10;i++)await request(app).post('/api/auth/login').set('Host','127.0.0.1').set('Origin','http://127.0.0.1').send({username:'owner',password:'invalid'});
  expect((await request(app).post('/api/auth/login').set('Host','127.0.0.1').set('Origin','http://127.0.0.1').send({username:'owner',password:'invalid'})).status).toBe(429);
});

test('public registration cannot claim owner data before local setup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'account-register-'));
  const store=createStore(join(dir,'ops.sqlite'));
  store.addAccount({id:'owner-only',name:'Owner private marker',handle:'owner-marker',profile:'local:owner',avatar:'',state:'connected',followers:0,lastSyncedAt:''});
  const app=createGreyApp(store,'fixture-token-more-than-32-characters',{authDataDir:dir});
  const register=await request(app).post('/api/auth/register').set('Host','public.example').set('Origin','http://public.example').send({username:'customer',password:'fixture-password-123'});
  expect(register.status).toBe(201);
  const cookie=register.headers['set-cookie'][0].split(';')[0];
  const profile=await request(app).get('/api/auth/profile').set('Cookie',cookie);
  expect(profile.body.workspace).toMatch(/^[a-f0-9-]{36}$/);
  expect(profile.body.workspace).not.toBe('owner');
  expect((await request(app).get('/api/operations').set('Cookie',cookie)).body.accounts).toEqual([]);
  expect((await request(app).get('/api/auth/status')).body.configured).toBe(false);
  const secondClient=await request(app).post('/api/auth/login').set('Host','public.example').set('Origin','http://public.example').send({username:'customer',password:'fixture-password-123'});
  expect(secondClient.status).toBe(200);
  const secondCookie=secondClient.headers['set-cookie'][0].split(';')[0];
  expect((await request(app).get('/api/auth/profile').set('Cookie',secondCookie)).body.workspace).toBe(profile.body.workspace);
  expect((await request(app).get('/api/auth/session').set('Cookie',cookie)).status).toBe(200);
  const setup=await request(app).post('/api/auth/setup').set('Host','127.0.0.1').set('Origin','http://127.0.0.1').send({username:'platform',password:'fixture-password-456'});
  expect(setup.status).toBe(201);
  const ownerCookie=setup.headers['set-cookie'][0].split(';')[0];
  expect((await request(app).get('/api/auth/profile').set('Cookie',ownerCookie)).body.workspace).toBe('owner');
  expect((await request(app).get('/api/operations').set('Cookie',ownerCookie)).body.accounts[0].id).toBe('owner-only');
  expect((await request(app).get('/api/auth/profile').set('Cookie',cookie)).body.workspace).toBe(profile.body.workspace);
});

test('local setup cannot reassign an existing public customer username or password',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'setup-collision-'));
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),'fixture-token-more-than-32-characters',{authDataDir:dir});
  const post=(path:string)=>request(app).post('/api/auth/'+path).set('Host','127.0.0.1').set('Origin','http://127.0.0.1');
  const customer=await post('register').send({username:'customer',password:'fixture-password-123'});
  const cookie=customer.headers['set-cookie'][0].split(';')[0];
  const before=(await request(app).get('/api/auth/profile').set('Cookie',cookie)).body.workspace;
  expect((await post('setup').send({username:'customer',password:'different-password-456'})).status).toBe(409);
  expect((await request(app).get('/api/auth/status')).body.configured).toBe(false);
  expect((await post('setup').send({username:'platform',password:'different-password-456'})).status).toBe(201);
  expect((await post('login').send({username:'customer',password:'fixture-password-123'})).status).toBe(200);
  expect((await post('login').send({username:'customer',password:'different-password-456'})).status).toBe(401);
  expect((await request(app).get('/api/auth/profile').set('Cookie',cookie)).body.workspace).toBe(before);
});

test('an existing customer using the configured platform username cannot manage shared templates',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'public-platform-name-'));
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),'fixture-token-more-than-32-characters',{authDataDir:dir,modelDataDir:dir,platformAdminUsername:'platform'});
  const workspace=randomUUID(),salt=randomBytes(16).toString('hex'),hash=scryptSync('fixture-password-123',salt,64).toString('hex');
  const file=join(dir,'accounts.sqlite');
  runSqlite(file,`INSERT INTO login_users VALUES('platform','${salt}','${hash}','${workspace}','Existing customer');`);
  const before=runSqlite(file,"SELECT salt,hash,workspace FROM login_users WHERE username='platform';");
  const login=await request(app).post('/api/auth/login').set('Host','public.example').set('Origin','http://public.example').send({username:'platform',password:'fixture-password-123'});
  expect(login.status).toBe(200);
  const cookie=login.headers['set-cookie'][0].split(';')[0];
  expect((await request(app).get('/api/auth/profile').set('Cookie',cookie)).body.workspace).toBe(workspace);
  expect((await request(app).get('/api/admin/templates').set('Cookie',cookie)).status).toBe(403);
  expect((await request(app).get('/api/templates/access').set('Cookie',cookie)).body.canManage).toBe(false);
  expect(runSqlite(file,"SELECT salt,hash,workspace FROM login_users WHERE username='platform';")).toBe(before);
});

test('configured platform username is reserved for local setup and then can manage shared templates',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'reserved-platform-name-'));
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),'fixture-token-more-than-32-characters',{authDataDir:dir,modelDataDir:dir,platformAdminUsername:'platform'});
  for(const username of ['platform','PLATFORM']){
    const rejected=await request(app).post('/api/auth/register').set('Host','public.example').set('Origin','http://public.example').send({username,password:'fixture-password-123'});
    expect(rejected.status).toBe(409);expect(rejected.body.message).toMatch(/平台.*保留.*其他账号/);
  }
  expect((await request(app).get('/api/auth/status')).body.configured).toBe(false);
  const setup=await request(app).post('/api/auth/setup').set('Host','127.0.0.1').set('Origin','http://127.0.0.1').send({username:'platform',password:'fixture-password-456'});
  expect(setup.status).toBe(201);
  const cookie=setup.headers['set-cookie'][0].split(';')[0];
  expect((await request(app).get('/api/auth/profile').set('Cookie',cookie)).body.workspace).toBe('owner');
  expect((await request(app).get('/api/admin/templates').set('Cookie',cookie)).status).toBe(200);
  expect((await request(app).get('/api/templates/access').set('Cookie',cookie)).body.canManage).toBe(true);
});

test('without a configured platform username public owner name still creates an independent customer',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'unreserved-name-'));
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),'fixture-token-more-than-32-characters',{authDataDir:dir});
  const registered=await request(app).post('/api/auth/register').set('Host','public.example').set('Origin','http://public.example').send({username:'owner',password:'fixture-password-123'});
  expect(registered.status).toBe(201);expect(registered.body.workspace).toMatch(/^[a-f0-9-]{36}$/);
  expect((await request(app).get('/api/auth/status')).body.configured).toBe(false);
});

test('remote forwarded requests cannot initialize owner through a Docker development flag',async()=>{
 const previous=process.env.MATRIX_LOCAL_DEV_DOCKER;process.env.MATRIX_LOCAL_DEV_DOCKER='1';
 const dir=mkdtempSync(join(tmpdir(),'remote-owner-setup-'));
 try{
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),'fixture-token-more-than-32-characters',{authDataDir:dir,publicOrigin:'https://customers.example.test'});
  app.set('trust proxy','loopback');
  const status=await request(app).get('/api/auth/status').set('Host','localhost').set('X-Forwarded-For','203.0.113.77');
  expect(status.body.setupAllowed).toBe(false);
  const response=await request(app).post('/api/auth/setup').set('Host','localhost').set('X-Forwarded-For','203.0.113.77').set('Origin','https://customers.example.test').send({username:'platform',password:'fixture-password-123'});
  expect(response.status).toBe(403);expect(response.headers['set-cookie']).toBeUndefined();
  expect((await request(app).get('/api/auth/status')).body.configured).toBe(false);
 }finally{if(previous===undefined)delete process.env.MATRIX_LOCAL_DEV_DOCKER;else process.env.MATRIX_LOCAL_DEV_DOCKER=previous;}
});

test.each([
  ['short ASCII','a'.repeat(11),400],
  ['72 ASCII bytes','a'.repeat(72),201],
  ['73 ASCII bytes','a'.repeat(73),400],
  ['72 UTF-8 bytes','密'.repeat(24),201],
  ['75 UTF-8 bytes','密'.repeat(25),400],
  ['six Unicode characters','🔐'.repeat(6),400],
  ['twelve Unicode characters','🔐'.repeat(12),201],
])('new registration validates %s',async(_name,password,status)=>{
  const dir=mkdtempSync(join(tmpdir(),'registration-password-'));
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),'fixture-token-more-than-32-characters',{authDataDir:dir});
  const result=await request(app).post('/api/auth/register').set('Host','public.example').set('Origin','http://public.example').send({username:'customer',password});
  expect(result.status).toBe(status);
});

test('existing 128-character scrypt password and workspace remain valid after registration and owner setup',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'legacy-password-'));
  const app=createGreyApp(createStore(join(dir,'ops.sqlite')),'fixture-token-more-than-32-characters',{authDataDir:dir});
  const password='a'.repeat(128),workspace=randomUUID(),salt=randomBytes(16).toString('hex'),hash=scryptSync(password,salt,64).toString('hex');
  const file=join(dir,'accounts.sqlite');
  runSqlite(file,`INSERT INTO login_users VALUES('legacy','${salt}','${hash}','${workspace}','Legacy');`);
  const before=runSqlite(file,"SELECT salt,hash,workspace FROM login_users WHERE username='legacy';");
  const post=(path:string)=>request(app).post('/api/auth/'+path).set('Host','127.0.0.1').set('Origin','http://127.0.0.1');
  expect((await post('register').send({username:'customer',password:'fixture-password-123'})).status).toBe(201);
  expect((await post('setup').send({username:'platform',password:'fixture-password-456'})).status).toBe(201);
  const login=await post('login').send({username:'legacy',password});
  expect(login.status).toBe(200);
  const cookie=login.headers['set-cookie'][0].split(';')[0];
  expect((await request(app).get('/api/auth/profile').set('Cookie',cookie)).body.workspace).toBe(workspace);
  expect(runSqlite(file,"SELECT salt,hash,workspace FROM login_users WHERE username='legacy';")).toBe(before);
});
