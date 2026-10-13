import {randomUUID,createHash} from 'node:crypto';
import {Postgres,type AsyncMethods,type Sql} from './postgres';
import {briefSchema,type StudioTask,type createStudio} from './studio';
import {creationInput,creationResult,type CreationTask,type createCreationQueue} from './creation-queue';
import {publishInput,completionInput,type PublishTask,type createPublishQueue} from './publish-queue';
import {templateInput,type createTemplateLibrary} from './template-library';
import type {ManagedTemplate,LibraryTemplate} from '../shared/templates';

export type Studio=AsyncMethods<ReturnType<typeof createStudio>>;
export type CreationQueue=AsyncMethods<ReturnType<typeof createCreationQueue>>;
export type PublishQueue=AsyncMethods<ReturnType<typeof createPublishQueue>>;
export type Templates=AsyncMethods<ReturnType<typeof createTemplateLibrary>>;

function taskRows(db:Postgres,tenant:string,kind:string){
  const list=async()=> (await db.rows(tenant,'SELECT payload FROM generation WHERE tenant_id=$1 AND kind=$2 ORDER BY created_at DESC,id',[tenant,kind])).map(r=>r.payload);
  const get=async(id:string,s?:Sql)=>{const q='SELECT payload FROM generation WHERE tenant_id=$1 AND kind=$2 AND id=$3';const r=s?(await s.query(q,[tenant,kind,id])).rows:await db.rows(tenant,q,[tenant,kind,id]);if(!r[0])throw Error('任务不存在');return r[0].payload;};
  const byRequest=async(id:string)=>(await db.rows(tenant,'SELECT payload FROM generation WHERE tenant_id=$1 AND kind=$2 AND request_id=$3',[tenant,kind,id]))[0]?.payload;
  const insert=async(task:any)=>{
    const result=await db.rows(tenant,`INSERT INTO generation(tenant_id,id,kind,request_id,account_id,revision,status,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,kind,request_id) DO NOTHING RETURNING payload`,[tenant,task.id,kind,task.requestId,task.accountId??null,task.revision??1,task.status,JSON.stringify(task),task.createdAt]);
    return {task:result[0]?.payload??await byRequest(task.requestId),fresh:result.length>0};
  };
  const save=async(task:any,status?:string,revision?:number)=>{
    const r=await db.rows(tenant,`UPDATE generation SET status=$4,revision=$5,payload=$6 WHERE tenant_id=$1 AND kind=$2 AND id=$3 AND ($7::text IS NULL OR status=$7) AND ($8::int IS NULL OR revision=$8) RETURNING payload`,[tenant,kind,task.id,task.status,task.revision??1,JSON.stringify(task),status??null,revision??null]);
    if(!r.length)throw Error('任务已被其他操作更新');return r[0].payload;
  };
  const claim=async(id:string)=>{
    const r=await db.rows(tenant,`UPDATE generation SET status='running',payload=jsonb_set(payload,'{status}','"running"') WHERE tenant_id=$1 AND kind=$2 AND id=$3 AND status='queued' RETURNING payload`,[tenant,kind,id]);
    if(!r.length)throw Error('任务已领取或不存在');return r[0].payload;
  };
  const remove=async(ids:string[],busy:string[])=>db.transaction(tenant,async s=>{
    const tasks=(await s.query('SELECT payload FROM generation WHERE tenant_id=$1 AND kind=$2 AND id=ANY($3::text[]) FOR UPDATE',[tenant,kind,ids])).rows.map(r=>r.payload);
    if(tasks.some(t=>busy.includes(t.status)))throw Error('选中任务正在执行，请先停止或等待结果');
    await s.query('DELETE FROM generation WHERE tenant_id=$1 AND kind=$2 AND id=ANY($3::text[])',[tenant,kind,ids]);
    return {deleted:tasks,missing:[...new Set(ids)].filter(id=>!tasks.some(t=>t.id===id))};
  });
  const del=async(id:string,busy:string[])=>{const r=await remove([id],busy);if(!r.deleted.length)throw Error('任务不存在');return r.deleted[0];};
  return {list,get,insert,save,claim,remove,del};
}
export function createPostgresStudio(db:Postgres,tenant:string):Studio{
  const r=taskRows(db,tenant,'studio'),busy=['generating','filling','approved','pending_confirmation'];
  return {
    list:r.list,get:r.get,
    create:async input=>{briefSchema.parse(input);const now=new Date().toISOString();const task:StudioTask={...input,id:randomUUID(),revision:1,createdAt:now,updatedAt:now,status:'generating',title:'',body:'',tags:[],images:[],message:'正在生成文案',history:[]};const saved=await r.insert(task);if(!saved.fresh&&['accountId','topic','persona','style','size','imageCount','imageMode','templateIds','strength'].some(k=>JSON.stringify(saved.task[k])!==JSON.stringify(task[k as keyof StudioTask])))throw Error('重复请求内容不一致');return saved;},
    update:async(id,revision,patch)=>{const old:StudioTask=await r.get(id);if(old.revision!==revision)throw Error('内容已更新，请刷新后重试');const now=new Date().toISOString();return r.save({...old,...patch,id:old.id,requestId:old.requestId,accountId:old.accountId,revision:revision+1,updatedAt:now,history:[...old.history,{at:now,status:patch.status??old.status,message:patch.message??''}]},undefined,revision);},
    delete:id=>r.del(id,busy),deleteMany:ids=>r.remove(ids,busy),
    deleteByAccount:async accountId=>{const tasks=(await r.list()).filter(t=>t.accountId===accountId);return (await r.remove(tasks.map(t=>t.id),busy)).deleted;}
  };
}
export function createPostgresCreation(db:Postgres,tenant:string):CreationQueue{
  const r=taskRows(db,tenant,'creation'),busy=['running','generating'];
  return {list:r.list,claim:r.claim,delete:id=>r.del(id,busy),deleteMany:ids=>r.remove(ids,busy),
    create:async raw=>{const input=creationInput.parse(raw),task:CreationTask={...input,id:randomUUID(),status:'queued',createdAt:new Date().toISOString()};const saved=(await r.insert(task)).task;if(Object.keys(input).some(k=>saved[k]!==input[k as keyof typeof input]))throw Error('重复请求内容不同，请重新提交');return saved;},
    complete:async raw=>{const input=creationResult.parse(raw),task=await r.get(input.taskId);if(task.status!=='running')throw Error('只能回传执行中的创作任务');if(input.status!=='failed'&&(!input.titles?.length||!input.body))throw Error('请回传标题和正文');if(input.images?.length&&!input.imageProvider)throw Error('请记录实际使用的生图服务');if(input.status==='completed'&&input.images?.length!==task.imageCount)throw Error('生成图片数量不足，请使用 partial 并说明原因');return r.save({...task,...input},'running');}
  };
}
export function createPostgresPublish(db:Postgres,tenant:string):PublishQueue{
  const r=taskRows(db,tenant,'publish'),busy=['running'];
  return {list:r.list,claim:r.claim,delete:id=>r.del(id,busy),deleteMany:ids=>r.remove(ids,busy),
    create:async raw=>{const input=publishInput.parse(raw);if(input.delivery==='publish'&&!input.confirmPublish)throw Error('请明确确认发布');const task:PublishTask={...input,id:randomUUID(),status:'queued',createdAt:new Date().toISOString()};const saved=(await r.insert(task)).task;if(['accountId','title','body','delivery','media'].some(k=>JSON.stringify(saved[k])!==JSON.stringify(task[k as keyof PublishTask])))throw Error('重复请求的内容不一致，请重新创建');return saved;},
    cancel:async id=>{const t=await r.get(id);if(t.status!=='queued')throw Error('仅可取消尚未领取的任务');return r.save({...t,status:'cancelled'},'queued');},
    complete:async raw=>{const input=completionInput.parse(raw),task=await r.get(input.taskId);if(task.status!=='running')throw Error('只有执行中的任务可以回传结果');if(input.status!=='failed'){if(!input.evidence)throw Error('成功状态需要实际页面结果证据');if(input.status==='published'&&(task.delivery!=='publish'||!input.url||!/^https:\/\/(www\.)?xiaohongshu\.com\//.test(input.url)))throw Error('发布结果需要真实小红书原文链接');if(input.status==='draft_saved'&&task.delivery!=='draft')throw Error('任务类型不匹配');}return r.save({...task,...input},'running');}
  };
}
export function createPostgresTemplates(db:Postgres,tenant:string):Templates{
  const list=async():Promise<ManagedTemplate[]> => (await db.rows(tenant,'SELECT payload FROM template WHERE tenant_id=$1 ORDER BY id',[tenant])).map(r=>r.payload);
  const get=async(id:string)=>{const r=(await db.rows(tenant,'SELECT payload FROM template WHERE tenant_id=$1 AND id=$2',[tenant,id]))[0];if(!r)throw Error('模板不存在');return r.payload as ManagedTemplate;};
  const fp=(d:ManagedTemplate['draft'])=>createHash('sha256').update(JSON.stringify([d.title.normalize('NFKC').replace(/\s/g,''),d.body.normalize('NFKC').replace(/\s/g,''),d.images])).digest('hex');
  const save=async(row:ManagedTemplate,expected:number)=>{const r=await db.rows(tenant,'UPDATE template SET payload=$3,revision=$4,fingerprint=$5 WHERE tenant_id=$1 AND id=$2 AND revision=$6 RETURNING payload',[tenant,row.id,JSON.stringify(row),row.revision,fp(row.draft),expected]);if(!r.length)throw Error('模板已更新，请刷新后重试');return r[0].payload;};
  return {list,published:async()=>(await list()).flatMap(r=>r.published?[r.published]:[]),
    deleteMany:async ids=>{await db.rows(tenant,'DELETE FROM template WHERE tenant_id=$1 AND id=ANY($2::text[])',[tenant,ids]);},
    create:async raw=>{const draft=templateInput.parse(raw),row:ManagedTemplate={id:randomUUID(),revision:1,draft,published:null,updatedAt:new Date().toISOString()};await db.rows(tenant,'INSERT INTO template VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,fingerprint) DO NOTHING',[tenant,row.id,fp(draft),1,JSON.stringify(row)]);return (await db.rows(tenant,'SELECT payload FROM template WHERE tenant_id=$1 AND fingerprint=$2',[tenant,fp(draft)]))[0].payload;},
    update:async(id,raw,expected)=>{const old=await get(id);return save({...old,draft:templateInput.parse(raw),revision:expected+1,updatedAt:new Date().toISOString()},expected);},
    publish:async(id,expected)=>{const row=await get(id);if(row.draft.usage!=='reference'&&!row.draft.rightsNote)throw Error('请填写来源授权说明');const published:LibraryTemplate={...row.draft,id,revision:row.revision,updatedAt:new Date().toISOString()};return save({...row,published},expected);},
    unpublish:async(id,expected)=>save({...await get(id),published:null},expected)
  };
}
