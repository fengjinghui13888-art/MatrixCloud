import {Postgres} from './postgres';
import type {XhsSyncJob} from './xhs-sync';
export function createPostgresJobs(db:Postgres,tenant:string){
 const recover=async()=>{await db.rows(tenant,`WITH expired AS (UPDATE job SET status='blocked',lease_until=NULL,payload=payload||jsonb_build_object('status','blocked','stage','blocked','message','同步执行超时或中断，已保存内容保留，请重新同步','finishedAt',now()) WHERE tenant_id=$1 AND kind='sync' AND status='running' AND lease_until<now() RETURNING id,attempt) UPDATE job_attempt a SET finished_at=now(),result='blocked' FROM expired e WHERE a.tenant_id=$1 AND a.job_id=e.id AND a.attempt=e.attempt`,[tenant]);};
 const read=async(id:string):Promise<XhsSyncJob|null>=>{await recover();return (await db.rows(tenant,"SELECT payload FROM job WHERE tenant_id=$1 AND id=$2 AND kind='sync'",[tenant,id]))[0]?.payload??null;};
 const latest=async(accountId:string):Promise<XhsSyncJob|null>=>{await recover();return (await db.rows(tenant,"SELECT payload FROM job WHERE tenant_id=$1 AND account_id=$2 AND kind='sync' ORDER BY created_at DESC LIMIT 1",[tenant,accountId]))[0]?.payload??null;};
 return {read,latest,
   create:async(state:XhsSyncJob)=>db.transaction(tenant,async s=>{
     await s.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':sync:'+state.accountId]);
     const current=(await s.query("SELECT payload FROM job WHERE tenant_id=$1 AND account_id=$2 AND kind='sync' AND status='running'",[tenant,state.accountId])).rows[0];
     if(current)return {state:current.payload as XhsSyncJob,fresh:false};
     await s.query("INSERT INTO job(tenant_id,id,account_id,kind,status,lease_until,payload,created_at) VALUES($1,$2,$3,'sync','running',now()+interval '19 minutes',$4,$5)",[tenant,state.id,state.accountId,JSON.stringify(state),state.startedAt]);
     await s.query('INSERT INTO job_attempt(tenant_id,job_id,attempt) VALUES($1,$2,1)',[tenant,state.id]);return {state,fresh:true};
   }),
   update:async(id:string,patch:Partial<XhsSyncJob>)=>db.transaction(tenant,async s=>{
     const old=(await s.query("SELECT payload FROM job WHERE tenant_id=$1 AND id=$2 AND kind='sync' FOR UPDATE",[tenant,id])).rows[0]?.payload;if(!old)throw Error('同步任务不存在');
     const confirmStop=old.status==='blocked'&&patch.stopConfirmed===true&&old.stopConfirmed!==true;
     if(old.status!=='running'&&!confirmStop)return old;
     const next=confirmStop?{...old,stopConfirmed:true,...(typeof patch.message==='string'?{message:patch.message}:{})}:{...old,...patch,id:old.id,accountId:old.accountId,profile:old.profile,startedAt:old.startedAt};
     await s.query('UPDATE job SET status=$3,payload=$4,lease_until=CASE WHEN $3=\'running\' THEN lease_until ELSE NULL END WHERE tenant_id=$1 AND id=$2',[tenant,id,next.status,JSON.stringify(next)]);
     if(old.status==='running'&&next.status!=='running')await s.query('UPDATE job_attempt SET finished_at=now(),result=$3 WHERE tenant_id=$1 AND job_id=$2 AND attempt=1',[tenant,id,next.status]);return next;
   }),
   running:async(accountId:string)=>{await recover();return !!(await db.rows(tenant,"SELECT 1 FROM job WHERE tenant_id=$1 AND account_id=$2 AND kind='sync' AND status='running'",[tenant,accountId])).length;}
 };
}
