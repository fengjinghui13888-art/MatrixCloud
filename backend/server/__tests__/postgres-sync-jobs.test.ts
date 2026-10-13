import {createPostgresJobs} from '../postgres-jobs';
import type {Postgres, Sql} from '../postgres';
import type {XhsSyncJob} from '../xhs-sync';

const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value));

// Model the query boundary so assertions observe persisted JSON and lease recovery.
// No Postgres connection, credentials, or network are involved.
function memoryPostgres(){
 let now=Date.parse('2026-10-08T00:00:00.000Z');
 const jobs=new Map<string,{payload:XhsSyncJob;status:XhsSyncJob['status'];leaseUntil:number|null}>();
 const attempts=new Map<string,{result:string|null;finishedAt:string|null}>();
 const key=(tenant:unknown,id:unknown)=>`${tenant}:${id}`;
 const query=async(sql:string,values:unknown[]=[])=>{
  const [tenant,id]=values;
  if(sql.startsWith('SELECT pg_advisory_xact_lock'))return {rows:[]};
  if(sql.startsWith('INSERT INTO job(')){
   const minutes=/interval '(\d+) minutes'/.exec(sql)?.[1];
   if(!minutes)throw Error('Missing sync lease interval');
   const payload=JSON.parse(values[3] as string) as XhsSyncJob;
   jobs.set(key(tenant,id),{payload,status:'running',leaseUntil:now+Number(minutes)*60_000});
   return {rows:[]};
  }
  if(sql.startsWith('INSERT INTO job_attempt')){
   attempts.set(key(tenant,id),{result:null,finishedAt:null});return {rows:[]};
  }
  if(sql.startsWith('WITH expired AS')){
   for(const [jobKey,job]of jobs){
    if(!jobKey.startsWith(`${tenant}:`)||job.status!=='running'||job.leaseUntil===null||job.leaseUntil>=now)continue;
    job.status='blocked';job.leaseUntil=null;
    job.payload={...job.payload,status:'blocked',stage:'blocked',message:'同步执行超时或中断，已保存内容保留，请重新同步',finishedAt:new Date(now).toISOString()};
    attempts.set(jobKey,{result:'blocked',finishedAt:new Date(now).toISOString()});
   }
   return {rows:[]};
  }
  if(sql.startsWith('SELECT payload FROM job')||sql.startsWith('SELECT 1 FROM job')){
   const matching=[...jobs.entries()].filter(([jobKey,job])=>
    jobKey.startsWith(`${tenant}:`)&&
    (sql.includes('account_id=$2')?job.payload.accountId===id:job.payload.id===id)&&
    (!sql.includes("status='running'")||job.status==='running'));
   matching.sort(([,a],[,b])=>b.payload.startedAt.localeCompare(a.payload.startedAt));
   return {rows:matching.map(([,job])=>sql.startsWith('SELECT 1')?{'?column?':1}:{payload:clone(job.payload)})};
  }
  if(sql.startsWith('UPDATE job SET status=$3,payload=$4')){
   const job=jobs.get(key(tenant,id));if(!job)throw Error('Missing job');
   job.status=values[2] as XhsSyncJob['status'];job.payload=JSON.parse(values[3] as string);
   if(job.status!=='running')job.leaseUntil=null;
   return {rows:[]};
  }
  if(sql.startsWith('UPDATE job_attempt SET finished_at=now(),result=$3')){
   attempts.set(key(tenant,id),{result:values[2] as string,finishedAt:new Date(now).toISOString()});return {rows:[]};
  }
  throw Error(`Unexpected query: ${sql}`);
 };
 const db={
  transaction:async<T>(_tenant:string,fn:(sql:Sql)=>Promise<T>)=>fn({query} as Sql),
  rows:async(_tenant:string,sql:string,values:unknown[])=> (await query(sql,values)).rows,
 } as unknown as Postgres;
 return {db,advance:(milliseconds:number)=>{now+=milliseconds;},attempt:(tenant:string,id:string)=>clone(attempts.get(key(tenant,id)))};
}

function state(overrides:Partial<XhsSyncJob>={}):XhsSyncJob{
 return {id:'sync-a',accountId:'a',profile:'local:a',status:'running',stage:'starting',message:'正在同步',counts:{notes:0,comments:0,messages:0},startedAt:'2026-10-08T00:00:00.000Z',...overrides};
}

test('queued sync remains running through the queue and execution budget and expires after 19 minutes',async()=>{
 const pg=memoryPostgres(),jobs=createPostgresJobs(pg.db,'tenant-a');
 await jobs.create(state({stage:'queued',queuePosition:1,message:'等待执行'}));
 pg.advance(18*60_000+59_000);
 expect(await createPostgresJobs(pg.db,'tenant-a').read('sync-a')).toMatchObject({status:'running',stage:'queued',queuePosition:1});
 expect(await jobs.running('a')).toBe(true);
 pg.advance(2_000);
 expect(await jobs.read('sync-a')).toMatchObject({status:'blocked',stage:'blocked'});
 expect(await jobs.running('a')).toBe(false);
 expect(pg.attempt('tenant-a','sync-a')?.result).toBe('blocked');
});

test('blocked sync persists a late stop confirmation without reopening or rewriting its terminal result',async()=>{
 const pg=memoryPostgres(),jobs=createPostgresJobs(pg.db,'tenant-a');
 await jobs.create(state());
 const blocked=await jobs.update('sync-a',{status:'blocked',stage:'blocked',message:'停止尚未确认',stopConfirmed:false,error:'执行超时',counts:{notes:6,comments:2,messages:1},finishedAt:'2026-10-08T00:02:00.000Z'});
 const attempt=pg.attempt('tenant-a','sync-a');pg.advance(60_000);
 const expected={...blocked,stopConfirmed:true,message:'停止已确认'};
 expect(await jobs.update('sync-a',{
  stopConfirmed:true,message:'停止已确认',status:'running',stage:'notes',error:'被覆盖',counts:{notes:99,comments:99,messages:99},finishedAt:'2026-10-08T00:03:00.000Z',
  id:'other',accountId:'other',profile:'local:other',startedAt:'2099-01-01',queuePosition:5,
 })).toEqual(expected);
 expect(await createPostgresJobs(pg.db,'tenant-a').read('sync-a')).toEqual(expected);
 expect(pg.attempt('tenant-a','sync-a')).toEqual(attempt);
 expect(await jobs.running('a')).toBe(false);
});

test('blocked sync can confirm stopping without replacing its message',async()=>{
 const pg=memoryPostgres(),jobs=createPostgresJobs(pg.db,'tenant-a');
 await jobs.create(state());
 const blocked=await jobs.update('sync-a',{status:'blocked',stage:'blocked',message:'执行已结束',finishedAt:'2026-10-08T00:02:00.000Z'});
 await jobs.update('sync-a',{stopConfirmed:true});
 expect(await createPostgresJobs(pg.db,'tenant-a').read('sync-a')).toEqual({...blocked,stopConfirmed:true});
});

test.each([undefined,false,'true'])('blocked sync ignores callbacks without a literal stop confirmation (%s)',async stopConfirmed=>{
 const pg=memoryPostgres(),jobs=createPostgresJobs(pg.db,'tenant-a');
 await jobs.create(state());
 const blocked=await jobs.update('sync-a',{status:'blocked',stage:'blocked',message:'停止尚未确认',stopConfirmed:false,finishedAt:'2026-10-08T00:02:00.000Z'});
 await jobs.update('sync-a',{stopConfirmed,status:'complete',stage:'finished',message:'旧回调',counts:{notes:99,comments:0,messages:0}} as Partial<XhsSyncJob>);
 expect(await createPostgresJobs(pg.db,'tenant-a').read('sync-a')).toEqual(blocked);
});

test.each(['complete','partial'] as const)('late stop confirmation cannot alter a terminal %s result',async status=>{
 const pg=memoryPostgres(),jobs=createPostgresJobs(pg.db,'tenant-a');
 await jobs.create(state());
 const terminal=await jobs.update('sync-a',{status,stage:'finished',message:'同步已完成',counts:{notes:6,comments:2,messages:1},finishedAt:'2026-10-08T00:02:00.000Z'});
 await jobs.update('sync-a',{stopConfirmed:true,status:'blocked',stage:'blocked',message:'停止已确认'});
 expect(await createPostgresJobs(pg.db,'tenant-a').read('sync-a')).toEqual(terminal);
});

test('confirmed blocked sync preserves its first confirmation against repeated callbacks',async()=>{
 const pg=memoryPostgres(),jobs=createPostgresJobs(pg.db,'tenant-a');
 await jobs.create(state());
 const terminal=await jobs.update('sync-a',{status:'blocked',stage:'blocked',message:'停止已确认',stopConfirmed:true,finishedAt:'2026-10-08T00:02:00.000Z'});
 await jobs.update('sync-a',{stopConfirmed:false,message:'停止尚未确认'});
 await jobs.update('sync-a',{stopConfirmed:true,message:'重复回调'});
 expect(await createPostgresJobs(pg.db,'tenant-a').read('sync-a')).toEqual(terminal);
});
