import {runSqliteJson} from './sqlite-client';
import {chmodSync} from 'node:fs';
import type {Postgres} from './postgres';
export function channelStorage(file:string,db?:Postgres){
  if(db)return {
    binding:async(w:string,p:string)=>(await db.rows(w,'SELECT device_id FROM device_binding WHERE tenant_id=$1 AND profile=$2',[w,p]))[0]?.device_id as string|undefined,
    selected:async(w:string)=>(await db.rows(w,'SELECT device_id FROM device_selection WHERE tenant_id=$1',[w]))[0]?.device_id as string|undefined,
    select:async(w:string,id:string)=>{await db.rows(w,'INSERT INTO device_selection VALUES($1,$2) ON CONFLICT(tenant_id) DO UPDATE SET device_id=excluded.device_id',[w,id]);},
    bind:async(w:string,p:string,id:string)=>{await db.rows(w,'INSERT INTO device_binding VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[w,p,id]);},
    run:async(w:string,id:string)=>(await db.rows(w,'SELECT device_id,profile,kind FROM device_run WHERE tenant_id=$1 AND id=$2',[w,id]))[0],
    addRun:async(w:string,id:string,device:string,profile:string,kind:string)=>{await db.rows(w,'INSERT INTO device_run VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[w,id,device,profile,kind]);}
  };
  const q=(s:string)=>`'${s.replaceAll("'","''")}'`;
  const sql=(query:string):any[]=>{const out=runSqliteJson(file,query).trim();return out?JSON.parse(out):[];};
  sql(`CREATE TABLE IF NOT EXISTS connector_bindings(workspace TEXT NOT NULL,profile TEXT NOT NULL,device_id TEXT NOT NULL,PRIMARY KEY(workspace,profile)); CREATE TABLE IF NOT EXISTS connector_selections(workspace TEXT PRIMARY KEY,device_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connector_runs(workspace TEXT NOT NULL,id TEXT NOT NULL,device_id TEXT NOT NULL,profile TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(workspace,id));`);chmodSync(file,0o600);
  return {
    binding:(w:string,p:string)=>sql(`SELECT device_id FROM connector_bindings WHERE workspace=${q(w)} AND profile=${q(p)}`)[0]?.device_id as string|undefined,
    selected:(w:string)=>sql(`SELECT device_id FROM connector_selections WHERE workspace=${q(w)}`)[0]?.device_id as string|undefined,
    select:(w:string,id:string)=>{sql(`INSERT INTO connector_selections VALUES(${q(w)},${q(id)}) ON CONFLICT(workspace) DO UPDATE SET device_id=excluded.device_id`);},
    bind:(w:string,p:string,id:string)=>{sql(`INSERT OR IGNORE INTO connector_bindings VALUES(${q(w)},${q(p)},${q(id)})`);},
    run:(w:string,id:string)=>sql(`SELECT * FROM connector_runs WHERE workspace=${q(w)} AND id=${q(id)}`)[0],
    addRun:(w:string,id:string,device:string,profile:string,kind:string)=>{sql(`INSERT OR IGNORE INTO connector_runs VALUES(${q(w)},${q(id)},${q(device)},${q(profile)},${q(kind)})`);}
  };
}
