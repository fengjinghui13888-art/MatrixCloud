// @vitest-environment node
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID,randomBytes,scryptSync} from 'node:crypto';
import request from 'supertest';import {createServer} from 'node:http';
import {Postgres} from '../postgres';import {createPostgresStore} from '../postgres-store';
import {createPostgresStudio,createPostgresCreation} from '../postgres-tasks';import {createPostgresModels} from '../postgres-models';
import {createPostgresPairing} from '../postgres-pairing';import {createConnectorChannel} from '../connector-channel';
import {createPostgresJobs} from '../postgres-jobs';import {createGreyApp} from '../grey-app';import {executionToken,withExecutionAccess} from '../execution-access';
import {createLocalAccounts} from '../local-accounts';
// @ts-ignore real connector protocol
import {startCloudChannel} from '../../../local-connector/cloud-channel.mjs';
const enabled=!!process.env.PG_TEST_ADMIN_URL_FILE;
const test=enabled?it:it.skip;
let admin:Postgres,db:Postgres,root:string;
const tenant=randomUUID(),other=randomUUID();
beforeAll(async()=>{if(!enabled)return;admin=new Postgres(readFileSync(process.env.PG_TEST_ADMIN_URL_FILE!,'utf8').trim());db=new Postgres(readFileSync(process.env.PG_TEST_APP_URL_FILE!,'utf8').trim());root=mkdtempSync(join(tmpdir(),'pg-integration-'));await admin.pool.query(readFileSync(new URL('../postgres-schema.sql',import.meta.url),'utf8'));await admin.pool.query('GRANT USAGE ON SCHEMA public TO matrix_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO matrix_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO matrix_app; REVOKE UPDATE,DELETE ON audit_log FROM matrix_app; REVOKE INSERT,UPDATE,DELETE ON schema_migration,legacy_migration FROM matrix_app;');for(const id of [tenant,other,'owner'])await admin.pool.query('INSERT INTO tenant(tenant_id,name) VALUES($1,$1) ON CONFLICT DO NOTHING',[id]);},30000);
afterAll(async()=>{if(!enabled)return;await db.close();await admin.close();rmSync(root,{recursive:true,force:true});});
const account=(id='a')=>({id,name:'Test account',handle:id,avatar:'',profile:'local:'+id,state:'connected' as const,followers:2,lastSyncedAt:'2026-09-15T00:00:00Z'});
const note=(id='n',accountId='a')=>({id,accountId,title:'测试内容',summary:'正文',cover:'https://example.com/a.png',url:null,publishedAt:'2026-09-15',metrics:{likes:1,collects:0,comments:1,shares:0},mediaType:'image' as const,videoUrl:null});
const comment=(id='c',accountId='a',noteId='n')=>({id,accountId,noteId,author:'客户',avatar:'',body:'咨询价格',status:'pending' as const,tags:[],createdAt:'2026-09-15'});

test('public concurrent registration stays outside owner and returns the same isolated workspace on a second client',async()=>{
 const names=['customer_a_','customer_b_','duplicate_','platform_'].map(prefix=>prefix+randomUUID().slice(0,8)),password='registration-fixture-password';
 const ownerStore=createPostgresStore(db,'owner'),marker='owner-marker-'+randomUUID();
 const app=createGreyApp(ownerStore,'registration-fixture-token-more-than-32-characters',{database:db,authDataDir:root,modelDataDir:root,publicOrigin:'https://customers.example.test',platformAdminUsername:names[3]});
 const post=(path:string,local=false)=>request(app).post('/api/auth/'+path).set('Host',local?'127.0.0.1':'customers.example.test').set('Origin','https://customers.example.test');
 const cookie=(r:any)=>r.headers['set-cookie'][0].split(';')[0];
 const workspaces=new Set<string>();
 let ownerMarkerAdded=false;
 try{
  expect((await request(app).get('/api/auth/status')).body.configured).toBe(false);
  await ownerStore.addAccount({...account(marker),name:'Private owner marker'});
  ownerMarkerAdded=true;
  for(const username of [names[3],names[3].toUpperCase()]){
   const rejected=await post('register').send({username,password});
   expect(rejected.status).toBe(409);expect(rejected.body.message).toMatch(/平台.*保留.*其他账号/);
  }
  const registered=await Promise.all(names.slice(0,2).map(username=>post('register').send({username,password})));
  for(const r of registered){expect(r.status).toBe(201);workspaces.add(r.body.workspace);}
  for(const workspace of workspaces){expect(workspace).toMatch(/^[a-f0-9-]{36}$/);expect(workspace).not.toBe('owner');}
  expect(workspaces.size).toBe(2);
  expect((await request(app).get('/api/auth/status')).body.configured).toBe(false);
  const duplicates=await Promise.all([names[2],names[2].toUpperCase()].map(username=>post('register').send({username,password})));
  expect(duplicates.map(r=>r.status).sort()).toEqual([201,409]);
  const duplicate=duplicates.find(r=>r.status===201)!;workspaces.add(duplicate.body.workspace);
  expect(duplicate.body.workspace).toMatch(/^[a-f0-9-]{36}$/);
  expect((await admin.pool.query('SELECT tenant_id FROM app_user WHERE username=$1',[names[2]])).rowCount).toBe(1);
  expect((await admin.pool.query('SELECT tenant_id FROM tenant WHERE name=$1',[names[2]])).rowCount).toBe(1);
  const a=createPostgresStore(db,registered[0].body.workspace,{allowSnapshotAccountCreation:true}),b=createPostgresStore(db,registered[1].body.workspace,{allowSnapshotAccountCreation:true});
  await Promise.all([a.importSnapshot({account:{...account('same-account'),name:'Client A marker'},notes:[{...note('same-note','same-account'),title:'Client A content'}],comments:[]}),b.importSnapshot({account:{...account('same-account'),name:'Client B marker'},notes:[{...note('same-note','same-account'),title:'Client B content'}],comments:[]})]);
  for(const [index,r]of registered.entries()){
   const response=await request(app).get('/api/operations').set('Cookie',cookie(r));
   expect(response.status).toBe(200);
   expect(response.body.accounts.map((a:any)=>a.name)).toEqual([index===0?'Client A marker':'Client B marker']);
   expect(response.body.notes.map((n:any)=>n.title)).toEqual([index===0?'Client A content':'Client B content']);
   expect(response.text).not.toContain('Private owner marker');
   expect((await request(app).get('/api/auth/tenants').set('Cookie',cookie(r))).status).toBe(403);
  }
  const secondClient=await post('login').send({username:names[0],password});
  expect(secondClient.status).toBe(200);expect(secondClient.body.workspace).toBe(registered[0].body.workspace);
  expect(cookie(secondClient)).not.toBe(cookie(registered[0]));
  expect((await request(app).get('/api/auth/session').set('Cookie',cookie(registered[0]))).status).toBe(200);
  expect((await request(app).get('/api/operations').set('Cookie',cookie(secondClient))).body.notes[0].title).toBe('Client A content');
  expect((await post('setup').send({username:names[3],password})).status).toBe(403);
  expect((await post('setup',true).send({username:names[0],password:'different-fixture-password'})).status).toBe(409);
  expect((await request(app).get('/api/auth/status')).body.configured).toBe(false);
  const owner=await post('setup',true).send({username:names[3],password});
  expect(owner.status).toBe(201);expect(owner.body.workspace).toBe('owner');
  expect((await request(app).get('/api/admin/templates').set('Cookie',cookie(owner))).status).toBe(200);
  expect((await request(app).get('/api/operations').set('Cookie',cookie(owner))).body.accounts.some((a:any)=>a.id===marker)).toBe(true);
  expect((await post('login').send({username:names[0],password})).body.workspace).toBe(registered[0].body.workspace);
 }finally{
  const created=(await admin.pool.query('SELECT tenant_id FROM app_user WHERE username=ANY($1::text[])',[names])).rows.map(r=>r.tenant_id).filter(id=>id!=='owner');
  if(ownerMarkerAdded)await ownerStore.deleteAccount(marker);
  await admin.pool.query('DELETE FROM xiaohongshu_account WHERE tenant_id=ANY($1::text[])',[created]);
  await admin.pool.query('DELETE FROM app_user WHERE username=ANY($1::text[])',[names]);
  await admin.pool.query('DELETE FROM audit_log WHERE tenant_id=ANY($1::text[])',[created]);
  await admin.pool.query('DELETE FROM tenant WHERE tenant_id=ANY($1::text[])',[created]);
 }
},30000);

test('new PostgreSQL credentials enforce UTF-8 limits while a legacy 128-character scrypt login keeps its hash and workspace',async()=>{
 const names=['byte_boundary_','byte_overflow_','unicode_short_','legacy_long_'].map(prefix=>prefix+randomUUID().slice(0,8)),workspace=randomUUID(),password='a'.repeat(128),salt=randomBytes(16).toString('hex'),hash=scryptSync(password,salt,64).toString('hex');
 const app=createGreyApp(createPostgresStore(db,'owner'),'password-fixture-token-more-than-32-characters',{database:db,authDataDir:root,modelDataDir:root});
 const post=(path:string)=>request(app).post('/api/auth/'+path).set('Host','127.0.0.1').set('Origin','http://127.0.0.1');
 try{
  const accepted=await post('register').send({username:names[0],password:'密'.repeat(24)});expect(accepted.status).toBe(201);
  expect((await post('login').send({username:names[0],password:'密'.repeat(24)})).status).toBe(200);
  expect((await post('register').send({username:names[1],password:'密'.repeat(25)})).status).toBe(400);
  expect((await post('register').send({username:names[2],password:'🔐'.repeat(6)})).status).toBe(400);
  await admin.pool.query('INSERT INTO tenant(tenant_id,name) VALUES($1,$2)',[workspace,names[3]]);
  await admin.pool.query("INSERT INTO app_user(tenant_id,username,password_hash,password_salt,display_name,role) VALUES($1,$2,$3,$4,$2,'admin')",[workspace,names[3],hash,salt]);
  const login=await post('login').send({username:names[3],password});expect(login.status).toBe(200);expect(login.body.workspace).toBe(workspace);
  const saved=(await admin.pool.query('SELECT password_hash,password_salt,tenant_id FROM app_user WHERE username=$1',[names[3]])).rows[0];
  expect(saved).toEqual({password_hash:hash,password_salt:salt,tenant_id:workspace});
 }finally{
  const created=(await admin.pool.query('SELECT tenant_id FROM app_user WHERE username=ANY($1::text[])',[names])).rows.map(r=>r.tenant_id).filter(id=>id!=='owner');
  await admin.pool.query('DELETE FROM app_user WHERE username=ANY($1::text[])',[names]);
  await admin.pool.query('DELETE FROM audit_log WHERE tenant_id=ANY($1::text[])',[created]);
  await admin.pool.query('DELETE FROM tenant WHERE tenant_id=ANY($1::text[])',[created]);
 }
},30000);

test('PostgreSQL owner setup rejects a forwarded public client despite a Docker development flag',async()=>{
 const previous=process.env.MATRIX_LOCAL_DEV_DOCKER;process.env.MATRIX_LOCAL_DEV_DOCKER='1';
 try{
  const app=createGreyApp(createPostgresStore(db,'owner'),'setup-fixture-token-more-than-32-characters',{database:db,authDataDir:root,modelDataDir:root,publicOrigin:'https://customers.example.test'});
  app.set('trust proxy','loopback');
  const client='203.0.113.'+(parseInt(randomUUID().slice(0,2),16)%200+1);
  const status=await request(app).get('/api/auth/status').set('Host','localhost').set('X-Forwarded-For',client);
  expect(status.body.setupAllowed).toBe(false);
  const response=await request(app).post('/api/auth/setup').set('Host','localhost').set('X-Forwarded-For',client).set('Origin','https://customers.example.test').send({username:'platform_'+randomUUID().slice(0,8),password:'fixture-password-123'});
  expect(response.status).toBe(403);expect(response.headers['set-cookie']).toBeUndefined();
 }finally{if(previous===undefined)delete process.env.MATRIX_LOCAL_DEV_DOCKER;else process.env.MATRIX_LOCAL_DEV_DOCKER=previous;}
});

test('normalized writes preserve accounts, media order and leads while concurrent operators never overwrite another account',async()=>{
 const a=createPostgresStore(db,tenant,{allowSnapshotAccountCreation:true}),b=createPostgresStore(db,other,{allowSnapshotAccountCreation:true});
 await Promise.all([a.importSnapshot({account:account(),notes:[note()],comments:[comment()]}),b.importSnapshot({account:account(),notes:[{...note(),title:'其他客户内容'}],comments:[comment()]})]);
 expect((await a.listNotes())[0].title).toBe('测试内容');expect((await b.listNotes())[0].title).toBe('其他客户内容');
 const writes=Array.from({length:12},(_,i)=>a.importSnapshot({account:account('matrix-'+i),notes:[note('note-'+i,'matrix-'+i)],comments:[]}));await Promise.all(writes);expect(await a.listAccounts()).toHaveLength(13);
 const leads=await Promise.all(Array.from({length:8},()=>a.createLeadFromComment('c',{level:'high'})));expect(new Set(leads.map(l=>l.id)).size).toBe(1);
 await a.addFollowUp(leads[0].id,'已联系','admin');expect(await a.deleteLead(leads[0].id)).toMatchObject({followUps:1});expect((await a.getComment('c'))?.status).toBe('pending');expect((await a.createLeadFromComment('c',{level:'low'})).id).not.toBe(leads[0].id);
 await expect(a.importSnapshot({account:account(),notes:[note('wrong','other-account')],comments:[]})).rejects.toThrow('归属');
 await expect(db.rows(tenant,'INSERT INTO note(tenant_id,id,account_id,title,published_at,metrics) VALUES($1,$2,$3,$4,$5,$6)',[tenant,'orphan','foreign','title','date','{}'])).rejects.toThrow();
 const production=createPostgresStore(db,tenant);await production.addAccount(account('deleted'));
 await production.deleteAccount('deleted');await expect(production.importSnapshot({account:account('deleted'),notes:[],comments:[]})).rejects.toThrow('账号已删除');
 const binding=createLocalAccounts(join(root,'verified-new-account'),production,{login:async()=>({}),state:async()=>({creatorLoggedIn:true,webLoggedIn:true,handle:'new-account',webHandle:'new-account',name:'Verified new account'})} as any);
 const login=await binding.start();const verified=await binding.status(login.id);expect(verified.status).toBe('authenticated');expect((await production.listAccounts()).some(a=>a.handle==='new-account')).toBe(true);await production.deleteAccount('xhs-new-account');
},30000);

test('RLS, least privilege, encrypted model configs and task revision checks apply to the real application role',async()=>{
 expect((await db.rows(tenant,'SELECT DISTINCT tenant_id FROM note')).map(r=>r.tenant_id)).toEqual([tenant]);
 await expect(db.rows(tenant,'UPDATE note SET title=$1 WHERE tenant_id=$2',['attack',other])).resolves.toEqual([]);
 await expect(db.pool.query('CREATE TABLE should_not_exist(id int)')).rejects.toThrow();
 const role=(await db.pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];expect(Object.values(role)).toEqual([false,false,false,false]);
 const dir=join(root,'models');mkdirSync(dir);writeFileSync(join(dir,'model-encryption-key'),randomBytes(32));const models=createPostgresModels(db,tenant,dir);
 const config={label:'测试模型',protocol:'chat-completions',baseUrl:'https://example.com/v1',model:'text-model',apiKey:'secret-only-for-tests',imageModel:'image-model',imageBaseUrl:'https://images.example.com/v1',imageApiKey:'image-secret-only-tests'};
 await models.save(config);const stored=await db.rows(tenant,'SELECT ciphertext FROM model_config WHERE tenant_id=$1',[tenant]);expect(JSON.stringify(stored)).not.toContain(config.apiKey);expect(JSON.stringify(await models.summary())).not.toContain(config.imageApiKey);expect(await createPostgresModels(db,tenant,dir).read()).toMatchObject(config);
 await expect(models.save({...config,baseUrl:'https://different.example/v1',apiKey:undefined})).rejects.toThrow();
 const missing=join(root,'missing-model-key');mkdirSync(missing);await expect(createPostgresModels(db,tenant,missing).read()).rejects.toThrow('模型加密密钥缺失');expect(existsSync(join(missing,'model-encryption-key'))).toBe(false);
 const studio=createPostgresStudio(db,tenant);const input={accountId:'a',topic:'测试',persona:'',style:'',imageCount:1,size:'1024x1536' as const,confirmCharge:true as const,requestId:'request-'+randomUUID()};
 const created=await Promise.all(Array.from({length:6},()=>studio.create(input)));expect(created.filter(r=>r.fresh)).toHaveLength(1);const t=created[0].task;
 const edits=await Promise.allSettled([studio.update(t.id,1,{title:'A'}),studio.update(t.id,1,{title:'B'})]);expect(edits.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 await expect(createPostgresStudio(db,other).get(t.id)).rejects.toThrow('不存在');
 const q=createPostgresCreation(db,tenant);const c=await q.create({topic:'t',sellingPoints:'',audience:'',style:'',imageCount:1,requestId:randomUUID()});const claims=await Promise.allSettled(Array.from({length:5},()=>q.claim(c.id)));expect(claims.filter(r=>r.status==='fulfilled')).toHaveLength(1);
},30000);

test('legacy scrypt login upgrades safely; same-tenant roles, disabled users and tenants are enforced through HTTP',async()=>{
 const salt=randomBytes(16).toString('hex'),username='owner_'+randomUUID().slice(0,8),password='test-password-123456';await admin.pool.query("INSERT INTO app_user(tenant_id,username,password_hash,password_salt,display_name,role) VALUES($1,$2,$3,$4,$2,'admin')",[tenant,username,scryptSync(password,salt,64).toString('hex'),salt]);
 const app=createGreyApp(createPostgresStore(db,'owner'),'test-service-token-more-than-32-characters',{database:db,authDataDir:root,modelDataDir:root});
 const post=(path:string,cookie='')=>request(app).post('/api/'+path).set('Host','127.0.0.1').set('Origin','http://127.0.0.1').set('Cookie',cookie);
 const login=await post('auth/login').send({username,password});expect(login.status).toBe(200);const cookie=login.headers['set-cookie'][0].split(';')[0];expect((await admin.pool.query('SELECT password_hash FROM app_user WHERE username=$1',[username])).rows[0].password_hash).toMatch(/^\$2/);
 const viewer='viewer_'+randomUUID().slice(0,8),operator='operator_'+randomUUID().slice(0,8);
 for(const [name,role]of [[viewer,'lead_viewer'],[operator,'operator']])expect((await post('auth/team',cookie).send({username:name,password,displayName:name,role})).status).toBe(201);
 const vc=(await post('auth/login').send({username:viewer,password})).headers['set-cookie'][0].split(';')[0],oc=(await post('auth/login').send({username:operator,password})).headers['set-cookie'][0].split(';')[0];
 const visible=await request(app).get('/api/operations').set('Cookie',vc);expect(visible.status).toBe(200);expect(visible.body).toMatchObject({role:'lead_viewer',notes:[],messages:[]});expect(visible.body.leads).toHaveLength(1);
 for(const path of ['models','connector/pairings','leads','studio/generate','accounts/sync-all','auth/team'])expect((await post(path,vc).send({})).status).toBe(403);
 expect((await request(app).get('/api/models').set('Cookie',vc)).status).toBe(403);expect((await post('models',oc).send({})).status).toBe(403);
 expect((await post('leads',oc).send({commentId:'c',level:'medium'})).status).toBe(200);
 const pair=await post('connector/pairings',oc).send({});expect(pair.status).toBe(201);
 const connected=await post('connector/register').send({code:pair.body.code,deviceName:'Operator PC',platform:'win32',version:'4.0.0'});expect(connected.status).toBe(201);
 const deviceId=connected.body.deviceId;
 expect((await post('connector/devices/'+deviceId+'/revoke',oc).send({})).status).toBe(403);
 expect((await request(app).get('/api/connector/devices').set('Cookie',oc)).body.devices.some((d:any)=>d.id===deviceId)).toBe(true);
 expect((await post('connector/devices/'+deviceId+'/revoke',cookie).send({})).status).toBe(200);
 expect((await request(app).get('/api/connector/devices').set('Cookie',oc)).body.devices.some((d:any)=>d.id===deviceId)).toBe(false);
 const resetPassword='A'.repeat(72);
 expect((await post('auth/team/'+operator,cookie).send({password:resetPassword})).status).toBe(200);
 expect((await request(app).get('/api/operations').set('Cookie',oc)).status).toBe(401);
 expect((await post('auth/login').send({username:operator,password:resetPassword+'extra'})).status).toBe(401);
 expect((await post('auth/login').send({username:operator,password:resetPassword})).status).toBe(200);
 expect((await post('auth/team/'+viewer,cookie).send({enabled:false})).status).toBe(200);expect((await request(app).get('/api/operations').set('Cookie',vc)).status).toBe(401);
 expect((await post('auth/team/'+username,cookie).send({role:'operator'})).status).toBe(409);
 await admin.pool.query('UPDATE tenant SET enabled=false WHERE tenant_id=$1',[tenant]);expect((await request(app).get('/api/operations').set('Cookie',cookie)).status).toBe(401);await admin.pool.query('UPDATE tenant SET enabled=true WHERE tenant_id=$1',[tenant]);
 const restarted=createGreyApp(createPostgresStore(db,'owner'),'test-service-token-more-than-32-characters',{database:db,authDataDir:root,modelDataDir:root});expect((await request(restarted).get('/api/operations').set('Cookie',cookie)).body.accounts).toHaveLength(13);
},30000);

test('sync leases claim once, persist progress, block stale callbacks and remain tenant scoped',async()=>{
 const jobs=createPostgresJobs(db,tenant),id=randomUUID(),state={id,accountId:'a',profile:'local:a',status:'running' as const,stage:'starting' as const,message:'start',counts:{notes:0,comments:0,messages:0},startedAt:new Date().toISOString()};
 const starts=await Promise.all(Array.from({length:5},()=>jobs.create({...state,id:randomUUID()})));expect(starts.filter(s=>s.fresh)).toHaveLength(1);const target=starts[0].state.id;
 await jobs.update(target,{stage:'queued',queuePosition:1,message:'等待执行'});
 const lease=(await db.rows(tenant,'SELECT status,EXTRACT(EPOCH FROM lease_until-now()) AS remaining_seconds FROM job WHERE tenant_id=$1 AND id=$2',[tenant,target]))[0];
 expect(lease.status).toBe('running');expect(Number(lease.remaining_seconds)).toBeGreaterThan(18*60);expect(Number(lease.remaining_seconds)).toBeLessThanOrEqual(19*60);
 expect(await createPostgresJobs(db,tenant).read(target)).toMatchObject({status:'running',stage:'queued',queuePosition:1});
 await jobs.update(target,{stage:'notes',counts:{notes:2,comments:0,messages:0}});expect((await createPostgresJobs(db,tenant).latest('a'))?.counts.notes).toBe(2);expect(await createPostgresJobs(db,other).read(target)).toBeNull();
 const blocked=await jobs.update(target,{status:'blocked',stage:'blocked',message:'cancelled',stopConfirmed:false,error:'cancelled',finishedAt:new Date().toISOString()});expect((await jobs.update(target,{status:'partial'})).status).toBe('blocked');
 const attempt=await db.rows(tenant,'SELECT finished_at,result FROM job_attempt WHERE tenant_id=$1 AND job_id=$2',[tenant,target]);expect(attempt[0].result).toBe('blocked');
 await jobs.update(target,{stopConfirmed:true,message:'停止已确认',status:'running',stage:'notes',counts:{notes:99,comments:99,messages:99},error:'stale callback',finishedAt:'2099-01-01'});
 const confirmed={...blocked,stopConfirmed:true,message:'停止已确认'};
 expect(await createPostgresJobs(db,tenant).read(target)).toEqual(confirmed);
 expect(await db.rows(tenant,'SELECT finished_at,result FROM job_attempt WHERE tenant_id=$1 AND job_id=$2',[tenant,target])).toEqual(attempt);
 await jobs.update(target,{status:'complete',stopConfirmed:false,message:'stale callback'});expect(await jobs.read(target)).toEqual(confirmed);expect(await jobs.running('a')).toBe(false);
 const expired=(await jobs.create({...state,id:randomUUID()})).state.id;await admin.pool.query("UPDATE job SET lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2",[tenant,expired]);expect((await jobs.read(expired))?.status).toBe('blocked');expect((await db.rows(tenant,'SELECT result FROM job_attempt WHERE tenant_id=$1 AND job_id=$2',[tenant,expired]))[0].result).toBe('blocked');
},30000);

test('real WebSocket transport keeps media chunk order, persists bindings and rejects disabled tenant',async()=>{
 const pairing=createPostgresPairing(db),code=await pairing.create(other);const device=await pairing.register(code.code,'Test PC','darwin','3.0.0');const channel=createConnectorChannel(pairing,'unused',db);await channel.bind(other,'local:test-profile',device.deviceId);
 const web=createServer();channel.attach(web);const listen=(s:any)=>new Promise<number>(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
 const port=await listen(web);const content=Buffer.concat(Array.from({length:24},(_,i)=>Buffer.alloc(65536,i)));const local=createServer((_req,res)=>{res.setHeader('content-type','application/octet-stream');res.end(content);});const localPort=await listen(local);let stop=()=>{};
 try{await new Promise<void>((resolve,reject)=>{stop=startCloudChannel({...device,cloudUrl:'http://127.0.0.1:'+port},{port:localPort,token:'fixture',onStatus:(s:string)=>{if(s==='connected')resolve();},onError:reject});});
 const run=randomUUID();await db.rows(other,'INSERT INTO device_run VALUES($1,$2,$3,$4,$5)',[other,run,device.deviceId,'local:test-profile','sync']);
 const bytes=await channel.request(other,device.deviceId,'GET','/sync/'+run+'/media/'+'a'.repeat(32));expect(bytes.data.equals(content)).toBe(true);
 expect(await createConnectorChannel(pairing,'unused',db).binding(other,'local:test-profile')).toBe(device.deviceId);
 await admin.pool.query('UPDATE tenant SET enabled=false WHERE tenant_id=$1',[other]);await expect(channel.request(other,device.deviceId,'GET','/verify')).rejects.toThrow();await admin.pool.query('UPDATE tenant SET enabled=true WHERE tenant_id=$1',[other]);
 }finally{stop();await new Promise<void>(r=>web.close(()=>r()));await new Promise<void>(r=>local.close(()=>r()));}
},30000);

test('generated copy and images persist through the real PostgreSQL HTTP path without live provider charges',async()=>{
 const id=randomUUID(),name='generation_'+id.slice(0,8),password='generation-fixture-password';await admin.pool.query('INSERT INTO tenant(tenant_id,name) VALUES($1,$1)',[id]);
 const bcrypt=await import('bcryptjs');await admin.pool.query("INSERT INTO app_user(tenant_id,username,password_hash,display_name,role) VALUES($1,$2,$3,$2,'admin')",[id,name,await bcrypt.hash(password,12)]);
 const store=createPostgresStore(db,id);await store.addAccount(account('generation-account'));
 const app=createGreyApp(createPostgresStore(db,'owner'),'generation-fixture-token-long-enough',{database:db,authDataDir:root,modelDataDir:root,modelTransport:async(url)=>url.endsWith('/images/generations')?{data:[{url:'https://example.test/fixture.png'}]}:{choices:[{message:{content:JSON.stringify({title:'数据库生成验证',body:'隔离测试生成正文',tags:['测试'],imagePrompt:'test image'})}}]}});
 const post=(path:string,cookie='')=>request(app).post('/api/'+path).set('Host','127.0.0.1').set('Origin','http://127.0.0.1').set('Cookie',cookie);
 const login=await post('auth/login').send({username:name,password});const cookie=login.headers['set-cookie'][0].split(';')[0];
 expect((await post('models',cookie).send({label:'Fixture',protocol:'chat-completions',baseUrl:'https://text.example/v1',model:'text',imageModel:'image',apiKey:'test-only-key'})).status).toBe(200);
 const input={accountId:'generation-account',topic:'验证',persona:'',style:'',imageCount:1,size:'1024x1536',requestId:randomUUID(),confirmCharge:true};
 const result=await post('studio/generate',cookie).send(input);expect(result.status).toBe(201);expect(result.body).toMatchObject({status:'review',body:'隔离测试生成正文',images:['https://example.test/fixture.png']});
 const task=await createPostgresStudio(db,id).get(result.body.id);expect(task.body).toBe(result.body.body);expect((await post('studio/generate',cookie).send(input)).body.id).toBe(task.id);
 expect((await request(app).get('/api/studio').set('Cookie',cookie)).body).toHaveLength(1);
},30000);
