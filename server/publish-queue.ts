import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runSqlite } from './sqlite-client';

export const publishInput=z.object({accountId:z.string().min(1),title:z.string().trim().min(1).max(20),body:z.string().trim().min(1).max(1000),media:z.array(z.string().url().startsWith('https://')).min(1).max(9),delivery:z.enum(['draft','publish']),confirmPublish:z.boolean().optional(),requestId:z.string().min(8).max(100)}).strict();
export const completionInput=z.object({taskId:z.string(),status:z.enum(['published','draft_saved','failed']),message:z.string().trim().min(1).max(2000),url:z.string().url().optional(),evidence:z.string().trim().min(1).max(4000).optional()});
export type PublishTask=z.infer<typeof publishInput>&{id:string;status:string;createdAt:string;message?:string;url?:string;evidence?:string};
export function createPublishQueue(path:string){
  const sql=(query:string)=>runSqlite(path,query).trim();
  const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
  const rows=(query:string):PublishTask[]=>{const text=sql(query);return text?text.split('\n').map(line=>JSON.parse(line)):[];};
  sql('CREATE TABLE IF NOT EXISTS publish_queue(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);');
  return {
    list:()=>rows('SELECT payload FROM publish_queue ORDER BY rowid DESC;'),
    delete(id:string){const task=rows(`SELECT payload FROM publish_queue WHERE id=${quote(id)};`)[0];if(!task)throw Error('发布任务不存在');if(task.status==='running')throw Error('发布任务正在执行，请先取消或等待结果后再删除');sql(`DELETE FROM publish_queue WHERE id=${quote(id)};`);return task;},
    deleteMany(ids:string[]){const unique=[...new Set(ids)],deleted:PublishTask[]=[],missing:string[]=[];for(const id of unique){const task=rows(`SELECT payload FROM publish_queue WHERE id=${quote(id)};`)[0];if(!task){missing.push(id);continue;}if(task.status==='running')throw Error(`发布任务 ${id} 正在执行，请先等待结果`);deleted.push(task);}if(deleted.length)sql(`DELETE FROM publish_queue WHERE id IN (${deleted.map(t=>quote(t.id)).join(',')});`);return {deleted,missing};},
    create(raw:unknown){
      const input=publishInput.parse(raw);
      if(input.delivery==='publish'&&!input.confirmPublish)throw Error('请明确确认发布');
      const task:PublishTask={...input,id:randomUUID(),status:'queued',createdAt:new Date().toISOString()};
      sql(`INSERT OR IGNORE INTO publish_queue VALUES(${quote(task.id)},${quote(input.requestId)},'queued',${quote(JSON.stringify(task))});`);
      const saved=rows(`SELECT payload FROM publish_queue WHERE request_id=${quote(input.requestId)};`)[0];
      if(saved.accountId!==input.accountId||saved.title!==input.title||saved.body!==input.body||saved.delivery!==input.delivery||JSON.stringify(saved.media)!==JSON.stringify(input.media))throw Error('重复请求的内容不一致，请重新创建');
      return saved;
    },
    claim(id:string){
      const task=rows(`UPDATE publish_queue SET status='running',payload=json_set(payload,'$.status','running') WHERE id=${quote(id)} AND status='queued' RETURNING payload;`)[0];
      if(!task)throw Error('任务不存在或已被领取，请勿重复发布');return task;
    },
    complete(raw:unknown){
      const input=completionInput.parse(raw);
      const task=rows(`SELECT payload FROM publish_queue WHERE id=${quote(input.taskId)};`)[0];
      if(!task||task.status!=='running')throw Error('只有执行中的任务可以回传结果');
      if(input.status!=='failed'){
        if(!input.evidence)throw Error('成功状态需要实际页面结果证据');
        if(input.status==='published'&&(task.delivery!=='publish'||!input.url||!/^https:\/\/(www\.)?xiaohongshu\.com\//.test(input.url)))throw Error('发布结果需要真实小红书原文链接');
        if(input.status==='draft_saved'&&task.delivery!=='draft')throw Error('任务类型不匹配');
      }
      const result={...task,...input};
      const updated=rows(`UPDATE publish_queue SET status=${quote(input.status)},payload=${quote(JSON.stringify(result))} WHERE id=${quote(task.id)} AND status='running' RETURNING payload;`)[0];
      if(!updated)throw Error('任务状态已变更');return updated;
    },
    cancel(id:string){const task=rows(`UPDATE publish_queue SET status='cancelled',payload=json_set(payload,'$.status','cancelled') WHERE id=${quote(id)} AND status='queued' RETURNING payload;`)[0];if(!task)throw Error('仅可取消尚未领取的任务');return task;}
  };
}
