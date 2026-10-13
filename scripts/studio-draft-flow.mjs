import {readPersistedImageDraft} from './studio-persisted-draft.mjs';
import {refreshPlatformDraftList} from './studio-refresh-drafts.mjs';
import {waitForSignal} from './studio-wait.mjs';
import {saveDraft,inspectDraftList,openImageDrafts} from './studio-draft.mjs';

// These orchestrators run locally. Only the short DOM functions execute in Chrome.
export async function inspectBeforeUpload(evaluate,title) {
 await evaluate(`(${refreshPlatformDraftList.toString()})()`);
 const stored=await evaluate(`(${readPersistedImageDraft.toString()})(${JSON.stringify(title)})`);
 if(stored.matches)throw Error('草稿箱已有同名内容，已停止重复上传，请核对现有草稿');
 const ready=await waitForSignal(()=>evaluate(`(()=>{(${openImageDrafts.toString()})();const drawer=document.querySelector('.draft-drawer');return !!drawer?.querySelector('.draft-list')&&!!drawer?.querySelector('.tab-item.active')?.textContent.includes('图文笔记');})()`),Boolean,{timeout:5000});
 if(!ready)throw Error('未能检查图文草稿箱，已停止重复上传');
 const actual=await evaluate(`(${inspectDraftList.toString()})(${JSON.stringify(title)})`);
 if(actual.matches)throw Error('草稿箱已有同名内容，已停止重复上传，请核对现有草稿');
 await evaluate(`(()=>{document.querySelector('.draft-drawer .d-drawer-close')?.click();return true;})()`);
 return actual;
}

export async function confirmVisibleDraft(evaluate,title){
 await evaluate(`(${refreshPlatformDraftList.toString()})()`);
 const ready=await waitForSignal(async()=>{await evaluate(`(${openImageDrafts.toString()})()`);return evaluate(`(${inspectDraftList.toString()})(${JSON.stringify(title)})`);},state=>state.drawer&&state.matches===1,{timeout:6000});
 return ready;
}

export async function saveAndConfirmDraft(evaluate,title,{save=()=>evaluate(`(${saveDraft.toString()})()`),acceptExisting=()=>false,showDrafts=async()=>{}}={}) {
 const before=await evaluate(`(${readPersistedImageDraft.toString()})(${JSON.stringify(title)})`);
 if(before.matches&&!acceptExisting(before))throw Error('草稿箱已有同名内容，已停止重复保存');
 await save();
 let sawSaved=false;
 const stored=await waitForSignal(async()=>{
  const state=await evaluate(`(${inspectDraftList.toString()})(${JSON.stringify(title)})`);sawSaved ||= state.saved;
  return evaluate(`(${readPersistedImageDraft.toString()})(${JSON.stringify(title)})`);
 },state=>state.available&&state.matches===1,{timeout:12000});
 if(stored.matches!==1)return {saved:false,drawer:false,matches:stored.matches??0};
 await showDrafts(stored);
 const visible=await confirmVisibleDraft(evaluate,title);
 return {...visible,saved:visible.matches===1&&stored.matches===1,persisted:stored,sawSaved};
}
