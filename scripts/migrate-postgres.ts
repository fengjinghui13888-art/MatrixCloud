import {existsSync,readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {runSqliteJson} from '../server/sqlite-client';
import {createHash} from 'node:crypto';
import {Postgres,databaseUrl} from '../server/postgres';
import {createPostgresStore} from '../server/postgres-store';
import {modelCipher} from '../server/postgres-models';
import type {Database} from '../server/domain';

const dir=process.argv[2];if(!dir||!databaseUrl())throw Error('需要数据目录和迁移数据库凭证');
const db=new Postgres(databaseUrl()!);
const read=(path:string,table:string)=>{
 if(!existsSync(path))return [];
 const tables=JSON.parse(runSqliteJson(path,"SELECT name FROM sqlite_master WHERE type='table'")||'[]');
 if(!tables.some((t:any)=>t.name===table))return [];
 return JSON.parse(runSqliteJson(path,'SELECT * FROM '+table)||'[]');
};
const stable=(v:any):any=>Array.isArray(v)?v.map(stable).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>[k,stable(v[k])])):v;
const hash=(v:any)=>createHash('sha256').update(JSON.stringify(stable(v))).digest('hex');
const report:any={schema:2,tenants:[],devices:0,verified:false};
try{
 await db.pool.query(readFileSync(new URL('../server/postgres-schema.sql',import.meta.url),'utf8'));
 const users=read(join(dir,'accounts.sqlite'),'login_users');
 const tenants=new Map<string,string>();for(const u of users)tenants.set(u.workspace,u.display_name||u.username);if(!tenants.has('owner'))tenants.set('owner','平台工作区');
 const currentTenants=new Set((await db.pool.query('SELECT tenant_id FROM tenant')).rows.map(r=>r.tenant_id));
 const folders=join(dir,'workspaces');if(existsSync(folders))for(const id of readdirSync(folders))if(/^[a-f0-9-]{36}$/.test(id)&&!tenants.has(id)&&!currentTenants.has(id))throw Error('发现无所属用户的工作区，停止迁移');
 for(const [tenant,name]of tenants)await db.pool.query('INSERT INTO tenant(tenant_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING',[tenant,name]);
 const migratedTenants=new Set((await db.pool.query('SELECT tenant_id FROM legacy_migration')).rows.map(r=>r.tenant_id));
 for(const u of users)if(!migratedTenants.has(u.workspace))await db.pool.query("INSERT INTO app_user(tenant_id,username,password_hash,password_salt,display_name,role) VALUES($1,$2,$3,$4,$5,'admin') ON CONFLICT(username) DO NOTHING",[u.workspace,u.username,u.hash,u.salt,u.display_name||u.username]);
 const sessions=read(join(dir,'accounts.sqlite'),'sessions'),sessionUsers=read(join(dir,'accounts.sqlite'),'session_users');
 for(const s of sessions){const username=sessionUsers.find((u:any)=>u.session_hash===s.hash)?.username,u=users.find((u:any)=>u.username===username);if(u&&!migratedTenants.has(u.workspace)&&s.expires>Date.now())await db.pool.query('INSERT INTO login_session VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[s.hash,u.workspace,u.username,s.expires]);}
 for(const [tenant]of tenants){
  // Completed tenants now belong to PostgreSQL. Legacy files are snapshots,
  // never an authoritative source for later deployments or new customer writes.
  if(migratedTenants.has(tenant)){report.tenants.push({tenant,alreadyMigrated:true});continue;}
  const root=tenant==='owner'?dir:join(dir,'workspaces',tenant);
  const saved=read(join(root,'operations.sqlite'),'operations_state');
  const state:Database=saved.length?JSON.parse(saved[0].payload):{accounts:[],notes:[],comments:[],messages:[],leads:[],followUps:[],members:[],syncRuns:[],templates:[]};
  state.messages??=[];
  if(state.templates?.length)throw Error('旧业务模板未关联模板库，需核对后迁移');
  // Repair only provably orphaned flags; no content is discarded.
  for(const c of state.comments)if(c.status==='lead_created'&&!state.leads.some(l=>l.sourceCommentId===c.id))c.status='pending';
  const manifest=Object.fromEntries(Object.entries(state).filter(([k])=>k!=='templates').map(([k,v])=>[k,{count:v.length,sha256:hash(v)}]));
  const sourceHash=hash(state);
  const done=(await db.rows(tenant,'SELECT source_hash FROM legacy_migration WHERE tenant_id=$1',[tenant]))[0];
  if(done){if(done.source_hash!==sourceHash)throw Error('旧数据在迁移后发生变化，拒绝覆盖新数据库');report.tenants.push({tenant,alreadyMigrated:true});continue;}
  const target=createPostgresStore(db,tenant,{allowSnapshotAccountCreation:true});
  if((await target.listAccounts()).length)throw Error('目标租户非空，拒绝覆盖');
  for(const account of state.accounts)await target.importSnapshot({account,notes:state.notes.filter(n=>n.accountId===account.id),comments:state.comments.filter(c=>c.accountId===account.id),messages:state.messages.filter(m=>m.accountId===account.id)});
  for(const l of state.leads)await db.rows(tenant,'INSERT INTO clue(tenant_id,id,account_id,source_note_id,source_comment_id,status,level,owner_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[tenant,l.id,l.accountId,l.sourceNoteId,l.sourceCommentId,l.status,l.level,l.ownerId??null,l.createdAt]);
  for(const c of state.comments)await target.updateComment(c.id,{status:c.status,tags:c.tags});
  for(const f of state.followUps)await db.rows(tenant,'INSERT INTO follow_up VALUES($1,$2,$3,$4,$5,$6)',[tenant,f.id,f.leadId,f.body,f.author,f.createdAt]);
  for(const m of state.members)await db.rows(tenant,'INSERT INTO team_member VALUES($1,$2,$3,$4,$5)',[tenant,m.id,m.name,m.role,m.avatar]);
  for(const r of state.syncRuns)await target.recordSync(r);
  const actual={accounts:await target.listAccounts(),notes:await target.listNotes(),comments:await target.listComments(),messages:await target.listMessages(),leads:await target.listLeads(),followUps:(await Promise.all(state.leads.map(l=>target.listFollowUps(l.id)))).flat(),members:await target.listMembers(),syncRuns:await target.listSyncRuns()};
  for(const [k,v]of Object.entries(actual))if(hash(v)!==(manifest as any)[k].sha256)throw Error('迁移数据核对失败：'+tenant+'/'+k);
  const taskCounts:any={};
  for(const [file,table,kind]of [['studio.sqlite','studio_tasks','studio'],['creation.sqlite','creation_tasks','creation'],['publish.sqlite','publish_queue','publish']]){
   const tasks=read(join(root,file),table);taskCounts[kind]=tasks.length;
   for(const r of tasks){const t=JSON.parse(r.payload);await db.rows(tenant,'INSERT INTO generation(tenant_id,id,request_id,account_id,kind,revision,status,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[tenant,t.id,t.requestId,t.accountId??null,kind,t.revision??1,t.status,r.payload,t.createdAt]);}
   const rows=(await db.rows(tenant,'SELECT payload FROM generation WHERE tenant_id=$1 AND kind=$2',[tenant,kind])).map(r=>r.payload);if(hash(rows)!==hash(tasks.map((r:any)=>JSON.parse(r.payload))))throw Error('任务迁移核对失败');
  }
  for(const t of read(join(root,'templates.sqlite'),'template_library'))await db.rows(tenant,'INSERT INTO template VALUES($1,$2,$3,$4,$5)',[tenant,t.id,t.fingerprint,t.revision,t.payload]);
  let models=0;
  if(existsSync(join(root,'model-settings.enc'))){const cipher=modelCipher(root),raw=cipher.decrypt(readFileSync(join(root,'model-settings.enc'),'utf8'));const collection=raw.profiles?raw:{activeId:'default',profiles:[{id:'default',settings:raw}]};for(const p of collection.profiles){await db.rows(tenant,'INSERT INTO model_config(tenant_id,id,label,active,ciphertext) VALUES($1,$2,$3,$4,$5)',[tenant,p.id,p.settings.label,p.id===collection.activeId,cipher.encrypt(p.settings)]);models++;}const back=(await db.rows(tenant,'SELECT id,active,ciphertext FROM model_config WHERE tenant_id=$1',[tenant])).map(r=>({id:r.id,settings:cipher.decrypt(r.ciphertext)}));if(hash(back)!==hash(collection.profiles))throw Error('模型密文迁移核对失败');}
  const jobRoot=join(root,'xhs-sync');if(existsSync(jobRoot))for(const name of readdirSync(jobRoot).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){const j=JSON.parse(readFileSync(join(jobRoot,name),'utf8'));if(j.status==='running')throw Error('迁移前必须停止同步任务');await db.rows(tenant,'INSERT INTO job(tenant_id,id,account_id,kind,status,payload,created_at) VALUES($1,$2,$3,\'sync\',$4,$5,$6)',[tenant,j.id,j.accountId,j.status,JSON.stringify(j),j.startedAt]);}
  await db.rows(tenant,'INSERT INTO legacy_migration VALUES($1,$2,$3,now())',[tenant,sourceHash,JSON.stringify({...manifest,tasks:taskCounts,models})]);report.tenants.push({tenant,manifest,tasks:taskCounts,models});
 }
 // After the first successful cutover, deleted/revoked bindings must not be
 // resurrected from the retained pre-upgrade SQLite snapshot.
 if(!existsSync(join(dir,'postgres-active'))){
 const pairing=join(dir,'connector-pairing.sqlite');
 for(const d of read(pairing,'connector_devices')){await db.pool.query('INSERT INTO device VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',[d.workspace,d.id,d.name,d.platform,d.version,d.token_hash,d.created_at,d.last_seen_at,d.revoked_at]);report.devices++;}
 for(const p of read(pairing,'connector_pairings'))await db.pool.query('INSERT INTO device_pairing VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[p.workspace,p.id,p.code_hash,p.expires_at,p.status,p.device_id,p.created_at]);
 for(const b of read(pairing,'connector_bindings'))await db.rows(b.workspace,'INSERT INTO device_binding VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[b.workspace,b.profile,b.device_id]);
 for(const s of read(pairing,'connector_selections'))await db.rows(s.workspace,'INSERT INTO device_selection VALUES($1,$2) ON CONFLICT DO NOTHING',[s.workspace,s.device_id]);
 for(const r of read(pairing,'connector_runs'))await db.rows(r.workspace,'INSERT INTO device_run VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[r.workspace,r.id,r.device_id,r.profile,r.kind]);
 }
 await db.pool.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM matrix_app; GRANT USAGE ON SCHEMA public TO matrix_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO matrix_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO matrix_app; REVOKE UPDATE,DELETE ON audit_log FROM matrix_app; REVOKE INSERT,UPDATE,DELETE ON schema_migration,legacy_migration FROM matrix_app; REVOKE CREATE ON SCHEMA public FROM PUBLIC;');
 report.verified=true;console.log(JSON.stringify(report,null,2));
}finally{await db.close();}
