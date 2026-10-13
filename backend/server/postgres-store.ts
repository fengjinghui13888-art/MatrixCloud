import {randomUUID} from 'node:crypto';
import type {Store,AccountFilter} from './store';
import type {Database,Lead} from './domain';
import {Postgres,type Sql,type AsyncMethods} from './postgres';

export type BusinessStore=AsyncMethods<Store>;
const accountCols='id,name,handle,avatar,profile,state,followers,last_synced_at AS "lastSyncedAt"';
const noteCols='id,account_id AS "accountId",title,summary,cover,url,published_at AS "publishedAt",metrics,media_type AS "mediaType",images,video_url AS "videoUrl",has_video_url,has_media_assets';
const commentCols='id,account_id AS "accountId",note_id AS "noteId",author,avatar,body,created_at AS "createdAt",status,tags';
const leadCols='id,account_id AS "accountId",source_note_id AS "sourceNoteId",source_comment_id AS "sourceCommentId",status,level,owner_id AS "ownerId",created_at AS "createdAt"';
const followCols='id,lead_id AS "leadId",body,author,created_at AS "createdAt"';
const compact=(row:any):any=>Object.fromEntries(Object.entries(row).filter(([k,v])=>v!==null||!['mediaType','images','videoUrl','ownerId','count'].includes(k)));

export function createPostgresStore(db:Postgres,tenant:string,{allowSnapshotAccountCreation=false}={}):BusinessStore{
  const rows=(text:string,values:unknown[]=[])=>db.rows(tenant,text,[tenant,...values]);
  const tx=<T>(fn:(s:Sql)=>Promise<T>)=>db.transaction(tenant,fn);
  const filter=(f:AccountFilter={})=>f.accountId&&f.accountId!=='all'?f.accountId:null;
  async function accounts(){return rows(`SELECT ${accountCols} FROM xiaohongshu_account WHERE tenant_id=$1 ORDER BY id`);}
  async function notes(f:AccountFilter={}){
    const result=await rows(`SELECT ${noteCols} FROM note WHERE tenant_id=$1 AND ($2::text IS NULL OR account_id=$2) ORDER BY published_at DESC,id`,[filter(f)]);
    const assets=await rows('SELECT id,account_id,note_id,kind,position AS index,source_url AS "sourceUrl",path,bytes::float8 AS bytes,sha256 FROM asset WHERE tenant_id=$1 AND ($2::text IS NULL OR account_id=$2) ORDER BY ordinal,id',[filter(f)]);
    return result.map(r=>{const a=assets.filter(a=>a.note_id===r.id&&a.account_id===r.accountId).map(({account_id,note_id,...a})=>a);const {has_video_url,has_media_assets,...n}=r;return {...compact(n),...(has_video_url?{videoUrl:r.videoUrl}:{}),...(has_media_assets||a.length?{mediaAssets:a}:{})};}) as Database['notes'];
  }
  async function comments(f:AccountFilter={}){return rows(`SELECT ${commentCols} FROM message WHERE tenant_id=$1 AND kind='comment' AND ($2::text IS NULL OR account_id=$2) ORDER BY created_at DESC,id`,[filter(f)]);}
  async function upsertAccount(s:Sql,a:Database['accounts'][number]){
    await s.query(`INSERT INTO xiaohongshu_account(tenant_id,id,name,handle,avatar,profile,state,followers,last_synced_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,id) DO UPDATE SET name=excluded.name,handle=excluded.handle,avatar=excluded.avatar,profile=excluded.profile,state=excluded.state,followers=excluded.followers,last_synced_at=excluded.last_synced_at`,[tenant,a.id,a.name,a.handle,a.avatar,a.profile,a.state,a.followers,a.lastSyncedAt]);
  }
  async function upsertNote(s:Sql,n:Database['notes'][number]){
    const old=(await s.query(`SELECT ${noteCols} FROM note WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[tenant,n.id])).rows[0];
    if(old&&old.accountId!==n.accountId)throw Error('记录归属冲突');
    const m=old?{...n,summary:n.summary??old.summary,cover:n.cover??old.cover,url:n.url??old.url,mediaType:n.mediaType??old.mediaType,images:n.images??old.images,videoUrl:n.videoUrl??old.videoUrl,metrics:Object.fromEntries(Object.entries(n.metrics).map(([k,v])=>[k,v??old.metrics[k]]))}:n;
    await s.query(`INSERT INTO note(tenant_id,id,account_id,title,summary,cover,url,published_at,metrics,media_type,images,video_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(tenant_id,id) DO UPDATE SET title=excluded.title,summary=excluded.summary,cover=excluded.cover,url=excluded.url,published_at=excluded.published_at,metrics=excluded.metrics,media_type=excluded.media_type,images=excluded.images,video_url=excluded.video_url`,[tenant,n.id,n.accountId,n.title,m.summary,m.cover,m.url,n.publishedAt,JSON.stringify(m.metrics),m.mediaType??null,m.images?JSON.stringify(m.images):null,m.videoUrl??null]);
    await s.query('UPDATE note SET has_video_url=has_video_url OR $3,has_media_assets=has_media_assets OR $4 WHERE tenant_id=$1 AND id=$2',[tenant,n.id,n.videoUrl!==undefined,n.mediaAssets!==undefined]);
    if(n.mediaAssets!==undefined){
      await s.query('DELETE FROM asset WHERE tenant_id=$1 AND account_id=$2 AND note_id=$3',[tenant,n.accountId,n.id]);
      for(const [ordinal,a] of n.mediaAssets.entries())await s.query('INSERT INTO asset VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[tenant,n.accountId,n.id,a.id,a.kind,a.index,a.sourceUrl,a.path,a.bytes,a.sha256,ordinal]);
    }
  }
  async function removeLeads(s:Sql,ids:string[]){
    const removed=(await s.query(`DELETE FROM clue WHERE tenant_id=$1 AND id=ANY($2::text[]) RETURNING ${leadCols}`,[tenant,ids])).rows;
    await s.query("UPDATE message SET status='pending' WHERE tenant_id=$1 AND kind='comment' AND id=ANY($2::text[]) AND status='lead_created'",[tenant,removed.map(r=>r.sourceCommentId)]);
    return removed;
  }
  async function counts(s:Sql,account:string|null,note:string|null=null){
    const a=[tenant,account,note];
    const condition='tenant_id=$1 AND ($2::text IS NULL OR account_id=$2)';
    const result:any={};
    for(const [key,query] of Object.entries({notes:`SELECT count(*) FROM note WHERE ${condition} AND ($3::text IS NULL OR id=$3)`,comments:`SELECT count(*) FROM message WHERE ${condition} AND kind='comment' AND ($3::text IS NULL OR note_id=$3)`,messages:`SELECT count(*) FROM message WHERE ${condition} AND kind='direct' AND $3::text IS NULL`,leads:`SELECT count(*) FROM clue WHERE ${condition} AND ($3::text IS NULL OR source_note_id=$3)`,followUps:`SELECT count(*) FROM follow_up WHERE tenant_id=$1 AND lead_id IN(SELECT id FROM clue WHERE ${condition} AND ($3::text IS NULL OR source_note_id=$3))`}))result[key]=Number((await s.query(query,a)).rows[0].count);
    return result;
  }
  return {
    listAccounts:accounts as Store['listAccounts']&any,listNotes:notes,listComments:comments as any,
    listMessages:async(f={})=>rows('SELECT id,account_id AS "accountId",conversation_id AS "conversationId",author,body,created_at AS "createdAt",direction FROM message WHERE tenant_id=$1 AND kind=\'direct\' AND ($2::text IS NULL OR account_id=$2) ORDER BY created_at,id',[filter(f)]) as any,
    listLeads:async(f={})=>(await rows(`SELECT ${leadCols} FROM clue WHERE tenant_id=$1 AND ($2::text IS NULL OR account_id=$2) ORDER BY created_at DESC,id`,[filter(f)])).map(compact) as Lead[],
    listMembers:async()=>rows('SELECT id,name,role,avatar FROM team_member WHERE tenant_id=$1') as any,
    listFollowUps:async id=>rows(`SELECT ${followCols} FROM follow_up WHERE tenant_id=$1 AND lead_id=$2 ORDER BY created_at,id`,[id]) as any,
    listSyncRuns:async()=>(await rows('SELECT id,account_id AS "accountId",status,message,created_at AS "createdAt",count FROM sync_run WHERE tenant_id=$1 ORDER BY created_at DESC')).map(compact) as any,
    getComment:async id=>(await rows(`SELECT ${commentCols} FROM message WHERE tenant_id=$1 AND kind='comment' AND id=$2`,[id]))[0],
    addAccount:async a=>tx(async s=>{
      // Account-local serialization also prevents two operators creating duplicate handles.
      await s.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':account:'+a.handle.toLowerCase()]);
      const old=(await s.query(`SELECT ${accountCols} FROM xiaohongshu_account WHERE tenant_id=$1 AND (id=$2 OR lower(handle)=lower($3))`,[tenant,a.id,a.handle])).rows[0];
      if(old)return old;await upsertAccount(s,a);return a;
    }),
    importSnapshot:async({account,notes,comments,messages=[]})=>{
      if([...notes,...comments,...messages].some(x=>x.accountId!==account.id))throw Error('账号归属不一致');
      await tx(async s=>{
        await s.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':account:'+account.id]);
        if(!allowSnapshotAccountCreation&&!(await s.query('SELECT 1 FROM xiaohongshu_account WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenant,account.id])).rowCount)throw Error('账号已删除或尚未连接，拒绝导入迟到的同步结果');
        await upsertAccount(s,account);
        for(const n of notes)await upsertNote(s,n);
        for(const c of comments)await s.query(`INSERT INTO message(tenant_id,id,account_id,kind,note_id,author,avatar,body,created_at,status,tags) VALUES($1,$2,$3,'comment',$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(tenant_id,account_id,kind,id) DO UPDATE SET author=excluded.author,avatar=excluded.avatar,body=excluded.body,created_at=excluded.created_at`,[tenant,c.id,c.accountId,c.noteId,c.author,c.avatar,c.body,c.createdAt,c.status,JSON.stringify(c.tags)]);
        for(const m of messages)await s.query(`INSERT INTO message(tenant_id,id,account_id,kind,conversation_id,author,body,created_at,direction) VALUES($1,$2,$3,'direct',$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,account_id,kind,id) DO UPDATE SET conversation_id=excluded.conversation_id,author=excluded.author,body=excluded.body,created_at=excluded.created_at,direction=excluded.direction`,[tenant,m.id,m.accountId,m.conversationId,m.author,m.body,m.createdAt,m.direction]);
        await s.query("UPDATE message m SET status='pending' WHERE tenant_id=$1 AND kind='comment' AND status='lead_created' AND NOT EXISTS(SELECT 1 FROM clue l WHERE l.tenant_id=m.tenant_id AND l.source_comment_id=m.id)",[tenant]);
      });
    },
    upsertNotes:async ns=>tx(async s=>{for(const n of ns)await upsertNote(s,n);}),
    recordSync:async r=>{await rows('INSERT INTO sync_run VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,id) DO NOTHING',[r.id,r.accountId,r.status,r.message,r.createdAt,r.count??null]);},
    deleteAccount:async id=>tx(async s=>{
      await s.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[tenant+':account:'+id]);
      const account=(await s.query(`SELECT ${accountCols} FROM xiaohongshu_account WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[tenant,id])).rows[0];if(!account)throw Error('账号不存在');
      const tasks=(await s.query('SELECT status FROM generation WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE',[tenant,id])).rows;
      if(tasks.some(t=>['generating','running','filling','approved','pending_confirmation'].includes(t.status)))throw Error('该账号仍有正在执行或等待确认的任务，请先处理任务');
      if((await s.query("SELECT 1 FROM job WHERE tenant_id=$1 AND account_id=$2 AND status='running'",[tenant,id])).rowCount)throw Error('该账号仍有同步任务');
      const result=await counts(s,id);await s.query('DELETE FROM generation WHERE tenant_id=$1 AND account_id=$2',[tenant,id]);await s.query('DELETE FROM xiaohongshu_account WHERE tenant_id=$1 AND id=$2',[tenant,id]);return {account,...result};
    }),
    deleteNote:async(accountId,noteId)=>tx(async s=>{
      const note=(await s.query(`SELECT ${noteCols} FROM note WHERE tenant_id=$1 AND account_id=$2 AND id=$3 FOR UPDATE`,[tenant,accountId,noteId])).rows[0];if(!note)throw Error('内容不存在或不属于该账号');
      const result=await counts(s,accountId,noteId);await s.query('DELETE FROM note WHERE tenant_id=$1 AND account_id=$2 AND id=$3',[tenant,accountId,noteId]);return {note,...result};
    }),
    deleteNotes:async items=>tx(async s=>{
      const result={deleted:0,missing:[] as string[],comments:0,leads:0,followUps:0};
      for(const {accountId,noteId} of new Map(items.map(i=>[JSON.stringify(i),i])).values()){
        if(!(await s.query('SELECT 1 FROM note WHERE tenant_id=$1 AND account_id=$2 AND id=$3 FOR UPDATE',[tenant,accountId,noteId])).rowCount){result.missing.push(noteId);continue;}
        const n=await counts(s,accountId,noteId);result.comments+=n.comments;result.leads+=n.leads;result.followUps+=n.followUps;result.deleted++;
        await s.query('DELETE FROM note WHERE tenant_id=$1 AND account_id=$2 AND id=$3',[tenant,accountId,noteId]);
      }return result;
    }),
    clearContent:async accountId=>tx(async s=>{const count=await counts(s,accountId??null);await s.query('DELETE FROM note WHERE tenant_id=$1 AND ($2::text IS NULL OR account_id=$2)',[tenant,accountId??null]);await s.query('DELETE FROM message WHERE tenant_id=$1 AND ($2::text IS NULL OR account_id=$2)',[tenant,accountId??null]);return count;}),
    createLead:async input=>createLead(input.sourceCommentId,{level:'medium'},false,input),
    createLeadFromComment:async(id,input)=>createLead(id,input,true),
    updateLead:async(id,patch)=>tx(async s=>{
      if(patch.ownerId&&!(await s.query('SELECT 1 FROM app_user WHERE tenant_id=$1 AND username=$2 AND enabled',[tenant,patch.ownerId])).rowCount)throw Error('跟进人不属于当前客户');
      const fields=Object.entries(patch).filter(([,v])=>v!==undefined);const names:Record<string,string>={ownerId:'owner_id',status:'status',level:'level'};
      const query=fields.length?`UPDATE clue SET ${fields.map(([k],i)=>`${names[k]}=$${i+3}`).join(',')} WHERE tenant_id=$1 AND id=$2 RETURNING ${leadCols}`:`SELECT ${leadCols} FROM clue WHERE tenant_id=$1 AND id=$2`;
      const r=(await s.query(query,[tenant,id,...fields.map(([,v])=>v)])).rows[0];if(!r)throw Error('Lead not found');return compact(r) as Lead;
    }),
    deleteLead:async id=>tx(async s=>{const n=Number((await s.query('SELECT count(*) FROM follow_up WHERE tenant_id=$1 AND lead_id=$2',[tenant,id])).rows[0].count);const lead=(await removeLeads(s,[id]))[0];if(!lead)throw Error('Lead not found');return {lead,followUps:n};}),
    deleteLeads:async ids=>tx(async s=>{const n=Number((await s.query('SELECT count(*) FROM follow_up WHERE tenant_id=$1 AND lead_id=ANY($2::text[])',[tenant,ids])).rows[0].count);const removed=await removeLeads(s,ids);return {deleted:removed.length,missing:[...new Set(ids)].filter(id=>!removed.some(r=>r.id===id)),followUps:n};}),
    addFollowUp:async(leadId,body,author)=>{const id=randomUUID();const r=await rows(`INSERT INTO follow_up VALUES($1,$2,$3,$4,$5,$6) RETURNING ${followCols}`,[id,leadId,body,author,new Date().toISOString()]);return r[0];},
    deleteFollowUp:async id=>{const r=(await rows(`DELETE FROM follow_up WHERE tenant_id=$1 AND id=$2 RETURNING ${followCols}`,[id]))[0];if(!r)throw Error('跟进记录不存在');return r;},
    deleteFollowUps:async ids=>{const r=await rows('DELETE FROM follow_up WHERE tenant_id=$1 AND id=ANY($2::text[]) RETURNING id',[ids]);return {deleted:r.length,missing:[...new Set(ids)].filter(id=>!r.some(r=>r.id===id))};},
    updateComment:async(id,p)=>{const r=(await rows(`UPDATE message SET status=coalesce($3,status),tags=coalesce($4,tags) WHERE tenant_id=$1 AND kind='comment' AND id=$2 RETURNING ${commentCols}`,[id,p.status??null,p.tags?JSON.stringify(p.tags):null]))[0];if(!r)throw Error('Comment not found');return r;}
  };
  async function createLead(id:string,input:{level:string;ownerId?:string},mark:boolean,source?:any){return tx(async s=>{
    const c=(await s.query(`SELECT ${commentCols} FROM message WHERE tenant_id=$1 AND kind='comment' AND id=$2 FOR UPDATE`,[tenant,id])).rows[0];if(!c)throw Error('Comment not found');
    if(source&&(source.accountId!==c.accountId||source.sourceNoteId!==c.noteId))throw Error('线索来源不一致');
    if(input.ownerId&&!(await s.query('SELECT 1 FROM app_user WHERE tenant_id=$1 AND username=$2 AND enabled',[tenant,input.ownerId])).rowCount)throw Error('跟进人不属于当前客户');
    const result=(await s.query(`INSERT INTO clue(tenant_id,id,account_id,source_note_id,source_comment_id,level,status,owner_id,created_at) VALUES($1,$2,$3,$4,$5,$6,'new',$7,$8) ON CONFLICT(tenant_id,source_comment_id) DO UPDATE SET level=CASE WHEN $9 THEN excluded.level ELSE clue.level END,owner_id=CASE WHEN $9 THEN excluded.owner_id ELSE clue.owner_id END RETURNING ${leadCols}`,[tenant,randomUUID(),c.accountId,c.noteId,c.id,input.level,input.ownerId??null,new Date().toISOString(),mark])).rows[0];
    if(mark)await s.query("UPDATE message SET status='lead_created' WHERE tenant_id=$1 AND kind='comment' AND id=$2",[tenant,id]);return compact(result) as Lead;
  });}
}
