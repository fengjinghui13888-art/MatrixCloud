import { randomUUID } from 'node:crypto';
import { runSqlite } from './sqlite-client';
import { z } from 'zod';

export const briefSchema=z.object({accountId:z.string().min(1),topic:z.string().trim().min(1).max(500),persona:z.string().max(1000),style:z.string().max(500),imageCount:z.number().int().min(1).max(12),size:z.enum(['1024x1024','1024x1536','1536x1024']),requestId:z.string().min(8).max(100),confirmCharge:z.literal(true),imageMode:z.enum(['direct','reference']).optional(),templateIds:z.array(z.string().uuid()).max(9).optional(),strength:z.number().min(0.5).max(0.7).optional()}).strict();
export const copySchema=z.object({title:z.string().trim().min(1).max(20),body:z.string().trim().min(1).max(900),tags:z.array(z.string().trim().min(1).max(20).regex(/^[^#\s,，]+$/)).max(5)});
export type StudioTask=z.infer<typeof briefSchema>&{id:string;revision:number;createdAt:string;updatedAt:string;status:'generating'|'generation_failed'|'review'|'rejected'|'approved'|'filling'|'filled'|'pending_confirmation'|'blocked'|'published';title:string;body:string;tags:string[];images:string[];message:string;executionRunId?:string;draftId?:string|number;executionStartedAt?:string;executionElapsedMs?:number;profile?:string;url?:string;noteId?:string;approvedRevision?:number;history:{at:string;status:string;message:string}[]};
export function createStudio(path:string){
 const q=(s:string)=>"'"+s.replaceAll("'","''")+"'";
 const sql=(query:string)=>runSqlite(path,query).trim();
 const rows=(s:string):StudioTask[]=>{const out=sql(s);return out?out.split('\n').map(x=>JSON.parse(x)):[];};
 sql('CREATE TABLE IF NOT EXISTS studio_tasks(id TEXT PRIMARY KEY, request_id TEXT UNIQUE, revision INTEGER NOT NULL, payload TEXT NOT NULL);');
 function get(id:string){const task=rows(`SELECT payload FROM studio_tasks WHERE id=${q(id)}`)[0];if(!task)throw Error('任务不存在');return task;}
 function update(id:string,revision:number,patch:Partial<StudioTask>){
  const old=get(id);if(old.revision!==revision)throw Error('内容已更新，请刷新后重试');
  const now=new Date().toISOString();const task={...old,...patch,revision:revision+1,updatedAt:now,history:[...old.history,{at:now,status:patch.status??old.status,message:patch.message??''}]};
  const saved=rows(`UPDATE studio_tasks SET revision=${task.revision},payload=${q(JSON.stringify(task))} WHERE id=${q(id)} AND revision=${revision} RETURNING payload`)[0];
  if(!saved)throw Error('任务已被其他操作更新');return saved;
 }
 return {get,update,list:()=>rows('SELECT payload FROM studio_tasks ORDER BY rowid DESC'),
  delete(id:string){const task=get(id);if(['generating','filling','approved','pending_confirmation'].includes(task.status))throw Error('创作任务正在执行，请先停止或等待结果后再删除');sql(`DELETE FROM studio_tasks WHERE id=${q(id)}`);return task;},
  deleteMany(ids:string[]){const unique=[...new Set(ids)],deleted:StudioTask[]=[],missing:string[]=[];for(const id of unique){const task=rows(`SELECT payload FROM studio_tasks WHERE id=${q(id)}`)[0];if(!task){missing.push(id);continue;}if(['generating','filling','approved','pending_confirmation'].includes(task.status))throw Error(`创作任务 ${id} 正在执行，请先停止或等待结果`);deleted.push(task);}if(deleted.length)sql(`DELETE FROM studio_tasks WHERE id IN (${deleted.map(t=>q(t.id)).join(',')})`);return {deleted,missing};},
  deleteByAccount(accountId:string){const tasks=rows(`SELECT payload FROM studio_tasks WHERE json_extract(payload,'$.accountId')=${q(accountId)}`);if(tasks.some(t=>['generating','filling','approved','pending_confirmation'].includes(t.status)))throw Error('该账号有正在执行的创作任务，请先停止或等待结果');if(tasks.length)sql(`DELETE FROM studio_tasks WHERE json_extract(payload,'$.accountId')=${q(accountId)}`);return tasks;},
  create(input:z.infer<typeof briefSchema>){
   const old=rows(`SELECT payload FROM studio_tasks WHERE request_id=${q(input.requestId)}`)[0];
   if(old){for(const key of ['accountId','topic','persona','style','size','imageCount','imageMode','templateIds','strength'] as const)if(JSON.stringify(old[key])!==JSON.stringify(input[key]))throw Error('重复请求内容不一致');return {task:old,fresh:false};}
   const now=new Date().toISOString();const task:StudioTask={...input,id:randomUUID(),revision:1,createdAt:now,updatedAt:now,status:'generating',title:'',body:'',tags:[],images:[],message:'正在生成文案',history:[]};
   sql(`INSERT INTO studio_tasks VALUES(${q(task.id)},${q(task.requestId)},1,${q(JSON.stringify(task))})`);return {task,fresh:true};
  }
 };
}
