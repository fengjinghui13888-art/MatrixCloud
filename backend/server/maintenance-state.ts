import {runSqliteJson} from './sqlite-client';
import {mkdirSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const q=(s:string)=>"'"+s.replaceAll("'","''")+"'";
/** Separate administrator state; never opens a customer database. */
export class MaintenanceState {
 readonly file:string;
 constructor(root:string){mkdirSync(root,{recursive:true,mode:0o700});this.file=join(root,'maintenance.sqlite');this.sql('CREATE TABLE IF NOT EXISTS item(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));');chmodSync(this.file,0o600);}
 private sql(statement:string){return runSqliteJson(this.file,statement);}
 get<T=any>(kind:string,id:string):T|undefined{const rows=JSON.parse(this.sql(`SELECT payload FROM item WHERE kind=${q(kind)} AND id=${q(id)};`)||'[]');return rows[0]?JSON.parse(rows[0].payload):undefined;}
 list<T=any>(kind:string):T[]{return JSON.parse(this.sql(`SELECT payload FROM item WHERE kind=${q(kind)} ORDER BY rowid DESC LIMIT 1000;`)||'[]').map((r:any)=>JSON.parse(r.payload));}
 put(kind:string,id:string,value:unknown){this.sql(`INSERT INTO item VALUES(${q(kind)},${q(id)},${q(JSON.stringify(value))}) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload;`);}
 remove(kind:string,id:string){this.sql(`DELETE FROM item WHERE kind=${q(kind)} AND id=${q(id)};`);}
 pruneExpiring(kinds:string[],now:number){if(!Number.isSafeInteger(now)||!kinds.length)throw Error('过期清理参数无效');this.sql(`DELETE FROM item WHERE kind IN (${kinds.map(q).join(',')}) AND json_type(payload,'$.expires') IN ('integer','real') AND json_extract(payload,'$.expires')<${now};`);}
 lock(id:string){try{this.sql(`INSERT INTO item VALUES('lock',${q(id)},'{}');`);}catch{throw Error('该操作正在执行或尚未核对上次结果');}return()=>this.remove('lock',id);}
 audit(actor:string,action:string,target:string,result:string){const id=randomUUID();this.put('audit',id,{id,actor,action,target,result,at:new Date().toISOString()});}
}
