import {chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';import {runSqlite} from './sqlite-client';
const q=(s:string)=>"'"+s.replaceAll("'","''")+"'";
/** Global account mutex on this single-host deployment, including different tenants/devices. */
export class BrowserRuns{
 private releaseHandlers=new Set<(lease:{id:string;profile:string})=>void|Promise<void>>();
 constructor(readonly file:string){this.sql('CREATE TABLE IF NOT EXISTS browser_run(account_hash TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,profile TEXT NOT NULL,created_at TEXT NOT NULL);');chmodSync(file,0o600);}
 private sql(s:string){return runSqlite(this.file,s).trim();}
 private key(handle:string){return createHash('sha256').update('xiaohongshu:'+handle.trim().toLowerCase()).digest('hex');}
 active(handle:string){const row=this.sql(`SELECT json_object('id',run_id,'profile',profile) FROM browser_run WHERE account_hash=${q(this.key(handle))}`);return row?JSON.parse(row) as {id:string;profile:string}:null;}
 assertAvailable(handle:string){if(this.sql(`SELECT run_id FROM browser_run WHERE account_hash=${q(this.key(handle))}`))throw Error('此账号仍有运行中或结果待核对的任务，请先停止并核对原执行电脑');}
 claim(handle:string,id:string,profile:string){const inserted=this.sql(`BEGIN IMMEDIATE;INSERT OR IGNORE INTO browser_run VALUES(${q(this.key(handle))},${q(id)},${q(profile)},${q(new Date().toISOString())});SELECT run_id FROM browser_run WHERE account_hash=${q(this.key(handle))};COMMIT;`);if(inserted!==id)throw Error('此账号正在另一台电脑执行任务，或上次停止尚未确认');}
 release(id:string){
  const deleted=this.sql(`DELETE FROM browser_run WHERE run_id=${q(id)} RETURNING json_object('id',run_id,'profile',profile);`);
  if(!deleted)return;
  const lease=JSON.parse(deleted) as {id:string;profile:string};
  for(const handler of this.releaseHandlers){try{void Promise.resolve(handler(lease)).catch(()=>{});}catch{}}
 }
 onRelease(handler:(lease:{id:string;profile:string})=>void|Promise<void>){this.releaseHandlers.add(handler);return()=>this.releaseHandlers.delete(handler);}
 /**
  * Remove any lease for an account after the account itself has been deleted.
  * Late callbacks are rejected because the account binding no longer exists,
  * so retaining the old run id would otherwise prevent re-adding the same
  * handle forever.
  */
  releaseAccount(handle:string){this.sql(`DELETE FROM browser_run WHERE account_hash=${q(this.key(handle))}`);}
}
