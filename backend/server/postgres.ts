import pg from 'pg';
import {readFileSync} from 'node:fs';

export type Sql = {query<T extends pg.QueryResultRow = any>(text:string,values?:unknown[]):Promise<pg.QueryResult<T>>};
export type AsyncMethods<T> = {[K in keyof T]:T[K] extends (...args:infer A)=>infer R ? (...args:A)=>R|Promise<Awaited<R>>:T[K]};
export class Postgres {
  readonly pool:pg.Pool;
  constructor(url:string){
    this.pool=new pg.Pool({connectionString:url,max:8,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,statement_timeout:10000,application_name:'matrix-cloud'});
    this.pool.on('error',()=>console.error('数据库连接中断，等待重连'));
  }
  async transaction<T>(tenant:string,fn:(sql:Sql)=>Promise<T>){
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenant]);
      const result=await fn(client);await client.query('COMMIT');return result;
    }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
  }
  async rows<T extends pg.QueryResultRow=any>(tenant:string,text:string,values:unknown[]=[]){return this.transaction(tenant,async sql=>(await sql.query<T>(text,values)).rows);}
  async active(tenant:string){return !!(await this.pool.query('SELECT 1 FROM tenant WHERE tenant_id=$1 AND enabled',[tenant])).rowCount;}
  async audit(tenant:string,actor:string,action:string,target:string,result:string){
    await this.rows(tenant,'INSERT INTO audit_log(tenant_id,actor,action,target,result) VALUES($1,$2,$3,$4,$5)',[tenant,actor,action,target,result]);
  }
  async close(){await this.pool.end();}
}
export function databaseUrl(){return process.env.DATABASE_URL_FILE?readFileSync(process.env.DATABASE_URL_FILE,'utf8').trim():process.env.DATABASE_URL;}
