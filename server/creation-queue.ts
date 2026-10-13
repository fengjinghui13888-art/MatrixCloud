import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runSqlite } from './sqlite-client';

export const creationInput=z.object({topic:z.string().trim().min(1).max(500),sellingPoints:z.string().trim().max(2000),audience:z.string().trim().max(500),style:z.string().trim().max(500),imageCount:z.number().int().min(1).max(12),requestId:z.string().min(8).max(100)}).strict();
export const creationResult=z.object({taskId:z.string(),status:z.enum(['completed','partial','failed']),titles:z.array(z.string().trim().min(1).max(20)).min(1).max(5).optional(),body:z.string().trim().min(1).max(1000).optional(),images:z.array(z.string().url().startsWith('https://')).max(12).optional(),imageProvider:z.string().trim().min(1).max(200).optional(),message:z.string().trim().min(1).max(2000)}).strict();
export type CreationTask=z.infer<typeof creationInput>&{id:string;status:string;createdAt:string;titles?:string[];body?:string;images?:string[];imageProvider?:string;message?:string};
export function createCreationQueue(path:string){
  const sql=(query:string)=>runSqlite(path,query).trim();
  const q=(value:string)=>"'"+value.replaceAll("'","''")+"'";
  const rows=(query:string):CreationTask[]=>{const text=sql(query);return text?text.split('\n').map(line=>JSON.parse(line)):[];};
  sql('CREATE TABLE IF NOT EXISTS creation_tasks(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);');
  return {
    list:()=>rows('SELECT payload FROM creation_tasks ORDER BY rowid DESC;'),
    delete(id:string){const task=rows(`SELECT payload FROM creation_tasks WHERE id=${q(id)};`)[0];if(!task)throw Error('创作任务不存在');if(['running','generating'].includes(task.status))throw Error('创作任务正在执行，请先等待或停止后再删除');sql(`DELETE FROM creation_tasks WHERE id=${q(id)};`);return task;},
    deleteMany(ids:string[]){const unique=[...new Set(ids)],deleted:CreationTask[]=[],missing:string[]=[];for(const id of unique){const task=rows(`SELECT payload FROM creation_tasks WHERE id=${q(id)};`)[0];if(!task){missing.push(id);continue;}if(['running','generating'].includes(task.status))throw Error(`创作任务 ${id} 正在执行，请先等待或停止`);deleted.push(task);}if(deleted.length)sql(`DELETE FROM creation_tasks WHERE id IN (${deleted.map(t=>q(t.id)).join(',')});`);return {deleted,missing};},
    create(raw:unknown){
      const input=creationInput.parse(raw);
      const task:CreationTask={...input,id:randomUUID(),status:'queued',createdAt:new Date().toISOString()};
      sql(`INSERT OR IGNORE INTO creation_tasks VALUES(${q(task.id)},${q(input.requestId)},'queued',${q(JSON.stringify(task))});`);
      const saved=rows(`SELECT payload FROM creation_tasks WHERE request_id=${q(input.requestId)};`)[0];
      if(Object.keys(input).some(key=>saved[key as keyof CreationTask]!==input[key as keyof typeof input]))throw Error('重复请求内容不同，请重新提交');
      return saved;
    },
    claim(id:string){const task=rows(`UPDATE creation_tasks SET status='running',payload=json_set(payload,'$.status','running') WHERE id=${q(id)} AND status='queued' RETURNING payload;`)[0];if(!task)throw Error('任务已领取或不存在');return task;},
    complete(raw:unknown){
      const input=creationResult.parse(raw);
      const task=rows(`SELECT payload FROM creation_tasks WHERE id=${q(input.taskId)};`)[0];
      if(!task||task.status!=='running')throw Error('只能回传执行中的创作任务');
      if(input.status!=='failed'&&(!input.titles?.length||!input.body))throw Error('请回传标题和正文');
      if(input.images?.length&&!input.imageProvider)throw Error('请记录实际使用的生图服务');
      if(input.status==='completed'&&input.images?.length!==task.imageCount)throw Error('生成图片数量不足，请使用 partial 并说明原因');
      const result={...task,...input};
      const updated=rows(`UPDATE creation_tasks SET status=${q(input.status)},payload=${q(JSON.stringify(result))} WHERE id=${q(task.id)} AND status='running' RETURNING payload;`)[0];
      if(!updated)throw Error('任务状态已变更');return updated;
    }
  };
}
