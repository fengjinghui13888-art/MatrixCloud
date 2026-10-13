import {waitForSignal} from './studio-wait.mjs';
import {readEditor} from './studio-page.mjs';
// Navigation can return before Chrome's renderer has a document. Read-only
// readiness probes tolerate that transition; no upload or save is retried.
export async function waitForCreator(read,ready,options={}){
 let error;
 const state=await waitForSignal(async()=>{try{return await read();}catch(e){error=e;return null;}},value=>!!value&&ready(value),{timeout:45000,...options});
 if(!state||!ready(state))throw Error(error?`创作页尚未就绪：${error.message}`:'创作页加载未完成，请保留窗口后重试');
 return state;
}

// Read the visible tab and reject any composer that could contain user work.
export function imageTabTarget(){
 const root=document.querySelector('#web');
 if(!root)return {reason:'创作页面尚未就绪'};
 if(root.querySelector('[contenteditable=true],video,.format-img')||[...root.querySelectorAll('input,textarea')].some(e=>e.type==='file'?e.files?.length:e.value?.trim()))return {reason:'当前创作页已有未保存内容，已保留原页面'};
 const candidates=[...root.querySelectorAll('.creator-tab')].filter(e=>e.textContent.trim()==='上传图文').filter(e=>{
  const r=e.getBoundingClientRect(),s=getComputedStyle(e);
  return r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&Number(s.opacity)>0.5&&s.visibility!=='hidden'&&e.getAttribute('aria-hidden')!=='true'&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
 });
 if(candidates.length!==1)return {reason:'未找到唯一可点击的上传图文入口'};
 const r=candidates[0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};
}

export async function prepareImageCreator(connection){
 const {page,evaluate}=connection;
 const tabs=await page.tabs();
 const creators=tabs.filter(t=>String(t.url||'').startsWith('https://creator.xiaohongshu.com/publish/publish'));
 const images=creators.filter(t=>new URL(t.url).searchParams.get('target')==='image');
 let existing;
 // Existing unsaved work belongs to the user. Read it without changing it,
 // reuse one empty page, or open one fresh page for this execution.
 for(const candidate of [...images,...creators.filter(t=>!images.includes(t))].slice(0,5)){
  await page.selectTab(candidate.page);await connection.foreground();
  const state=await waitForCreator(()=>evaluate(`(()=>({...(${readEditor.toString()})(),ready:!!document.querySelector('#web')}))()`),v=>v.ready);
  if(state.editor||state.imageCount||state.pendingImageCount||state.title||state.text)continue;
  existing=candidate;break;
 }
 const tab=existing?.page??await page.newTab('https://creator.xiaohongshu.com/publish/publish?from=menu_left&target=image');
 if(!tab)throw Error('浏览器未返回创作页标识');
 await page.selectTab(tab);await connection.foreground();
 // A previous verification can leave the platform draft drawer open. Close
 // only this drawer before locating the visible image tab.
 if(existing)await evaluate(`(()=>{document.querySelector('.draft-drawer .d-drawer-close')?.click();return true;})()`);
 if(existing&&new URL(existing.url).searchParams.get('target')!=='image'){
  const target=await waitForSignal(()=>evaluate(`(${imageTabTarget.toString()})()`),v=>!v.reason,{timeout:3000});
  if(target.reason)throw Error(target.reason);
  await page.nativeClick(target.x,target.y);
  await waitForCreator(()=>evaluate(`(${readEditor.toString()})()`),v=>new URL(v.url).searchParams.get('target')==='image');
 }
 return tab;
}
