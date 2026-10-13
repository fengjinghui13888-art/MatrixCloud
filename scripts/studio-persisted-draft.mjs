import {matchesNativeTopicText} from './studio-copy.mjs';
// Read-only proof from the platform's own local draft store. Never insert or
// modify a platform draft here; the visible Save Draft action remains mandatory.
export async function readPersistedImageDraft(title,{timeoutMs=4000,attempts=2}={}){
 // The function is serialized into Chrome, so helpers must remain inside it.
 // Retry reads only. Never interpret a stalled store as an empty draft box.
 for(let attempt=1;attempt<=attempts;attempt++){
 let db,transaction,expired=false,stage='草稿库枚举',timer;
 const read=async()=>{
 const databases=await indexedDB.databases();if(expired)return;
 if(!databases.some(d=>d.name==='draft-database-v1'))return {available:false,matches:0};
 stage='草稿库打开';
 const opened=indexedDB.open('draft-database-v1');db=await new Promise((resolve,reject)=>{opened.onsuccess=()=>{if(expired){opened.result.close();resolve(null);}else resolve(opened.result);};opened.onerror=()=>reject(opened.error);opened.onblocked=()=>reject(Error('平台草稿库被占用，请关闭该账号其他创作页面后重试'));});
 if(expired||!db)return;
 try{
  if(!db.objectStoreNames.contains('image-draft'))return {available:false,matches:0};
  const uid=localStorage.getItem('snsWebPublishCurrentUser');if(!uid)return {available:false,matches:0};
  stage='草稿内容读取';transaction=db.transaction('image-draft','readonly');
  const request=transaction.objectStore('image-draft').getAll();
  const rows=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const matches=rows.filter(row=>row.uid===uid&&row.content?.draftStore?.title===title);
  return {available:true,matches:matches.length,draftIds:matches.map(row=>row.draftId),records:matches.map(row=>({draftId:row.draftId,uid:row.uid,timeStamp:row.timeStamp,title:row.content.draftStore.title,body:row.content.draftStore.desc,images:row.content.draftStore.imgList?.map(image=>({fileId:image.fileId,status:image.status})),tags:row.content.draftStore.hashTag})) };
 }finally{db.close();}
 };
 try{return await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;try{transaction?.abort();}catch{}db?.close();reject(Error(stage+'超时，未确认现有草稿，已停止上传'));},timeoutMs);})]);}
 catch(error){if(!expired||attempt===attempts)throw error;}
 finally{clearTimeout(timer);}
 }
}

export function verifyPersistedDraft(snapshot,task,expectedFileIds,{requireNativeTopics=false}={}){
 if(!snapshot?.available||snapshot.matches!==1||snapshot.records?.length!==1)return null;
 const row=snapshot.records[0],tags=row.tags??[];
 const normalizedTags=tags.map(tag=>typeof tag==='string'?tag:tag?.name??tag?.topicName??'').map(tag=>tag.replace(/^#/,''));
 // The platform serializes an empty ProseMirror paragraph as a tab-only line.
 // Plain hashtags inserted into the editor live in desc, while selected topic
 // chips live in hashTag. Verify the exact approved suffix in either form.
 const canonical=s=>String(s??'').replace(/\r/g,'').replace(/^\t+$/gm,'');
 const body=canonical(row.body),approvedBody=canonical(task.body);
 const suffix=task.tags.length?'\n'+task.tags.map(tag=>'#'+tag).join(' '):'';
 const structured=body===approvedBody&&JSON.stringify(normalizedTags)===JSON.stringify(task.tags);
 const inline=normalizedTags.length===0&&body===approvedBody+suffix;
 const native=matchesNativeTopicText(body,approvedBody,task.tags,{persisted:true})&&JSON.stringify(normalizedTags)===JSON.stringify(task.tags)&&tags.every(t=>t.id&&t.link);
 if(requireNativeTopics&&task.tags.length&&!native)throw Error('草稿中的标签尚未关联小红书真实话题，不能确认同步成功');
 if(row.title!==task.title||(!structured&&!inline&&!native)||!Array.isArray(row.images)||row.images.length!==task.images.length||row.images.some(image=>!image.fileId||image.status!==2))throw Error('已有同名草稿与审核稿不一致，已停止重复上传，请人工核对');
 if(!Array.isArray(expectedFileIds)||expectedFileIds.length!==row.images.length||row.images.some((image,index)=>image.fileId!==expectedFileIds[index]))throw Error('已有草稿图片与本次上传回读不一致，已停止重复上传');
 return {title:row.title,body:task.body,tags:task.tags,imageCount:row.images.length,draftId:row.draftId};
}

export function uploadedDraftFileIds(){
 const states=[];for(const e of document.querySelectorAll('*'))if(e.__vue_app__){const provides=e.__vue_app__._context?.provides;if(!provides)continue;for(const key of Reflect.ownKeys(provides)){const draft=provides[key]?.state?.value?.draft;if(draft?.imgList?.length)states.push(draft.imgList);}}
 if(states.length!==1||states[0].some(image=>!image.fileId||image.status!==2))throw Error('图片上传尚未得到平台文件编号');
 return states[0].map(image=>image.fileId);
}
