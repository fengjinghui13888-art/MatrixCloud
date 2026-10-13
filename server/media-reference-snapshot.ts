import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {Postgres,databaseUrl} from './postgres';
/** Run on the host with the business container stopped. Never use stale SQLite references. */
const container=process.env.MATRIX_CONTAINER??'matrix-cloud';
if(!/^[\w.-]+$/.test(container)||execFileSync('docker',['inspect','--format={{.State.Running}}',container],{encoding:'utf8'}).trim()!=='false')throw Error('媒体引用检查要求业务容器已停止');
const url=databaseUrl(),output=process.env.MEDIA_REFERENCE_OUTPUT;if(!url||!output)throw Error('需要数据库配置和引用清单输出路径');
const db=new Postgres(url);const files=new Set<string>();
function visit(value:unknown,tenant:string){if(typeof value==='string'){const m=/^\/api\/templates\/media\/([a-f0-9]{64}\.(png|jpg|webp))$/.exec(value);if(m)files.add('template-uploads/'+tenant+'/'+m[1]);}else if(Array.isArray(value))value.forEach(v=>visit(v,tenant));else if(value&&typeof value==='object')for(const [k,v]of Object.entries(value)){if(k==='path'&&typeof v==='string'&&!v.includes('..')&&!v.startsWith('/')){files.add((tenant==='owner'?'':'workspaces/'+tenant+'/')+'media/'+v);}else visit(v,tenant);}}
try{
 const tenants=(await db.pool.query('SELECT tenant_id FROM tenant')).rows;
 for(const {tenant_id:tenant}of tenants){await db.transaction(tenant,async sql=>{
  const active=await sql.query("SELECT 1 FROM job WHERE tenant_id=$1 AND status IN ('running','queued','stopping') UNION ALL SELECT 1 FROM generation WHERE tenant_id=$1 AND status IN ('generating','filling') LIMIT 1",[tenant]);if(active.rows.length)throw Error('仍有活动任务，禁止清理');
  for(const table of ['note','asset','template','generation']){const rows=(await sql.query(`SELECT to_jsonb(t) AS data FROM ${table} t WHERE tenant_id=$1`,[tenant])).rows;for(const row of rows)visit(row.data,tenant);}
 });}
 writeFileSync(output,JSON.stringify({format:1,source:'postgres',offline:true,createdAt:Date.now(),files:[...files].sort()},null,2),{mode:0o600});
}finally{await db.close();}
