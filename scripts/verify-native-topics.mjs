import {connectPage} from '../local-connector/cdp.mjs';
import {uploadLocalFiles} from './studio-browser.mjs';
import {readEditor,fillEditor,verifyEditor} from './studio-page.mjs';
import {fillNativeTopics} from './studio-topics.mjs';
import {uploadedDraftFileIds,verifyPersistedDraft} from './studio-persisted-draft.mjs';
import {saveAndConfirmDraft} from './studio-draft-flow.mjs';
import {clickDraftButton} from './studio-save-button.mjs';
import {waitForSignal} from './studio-wait.mjs';
import {writeFile} from 'node:fs/promises';
const c=await connectPage(55626);
const task={title:'自动话题闭环验收0916',body:'自动话题功能验收，仅保存草稿。\n\n确认两个平台真实话题链接。',tags:['生活记录','记录生活'],images:['fixture']};
const ready=()=>waitForSignal(()=>c.evaluate(`location.origin==='https://creator.xiaohongshu.com'&&!!document.querySelector('#web')`).catch(()=>false),Boolean,{timeout:15000});
try{
 await c.page.selectTab(await c.page.newTab('https://creator.xiaohongshu.com/publish/publish?target=image'));await ready();
 await waitForSignal(()=>c.evaluate(`!!document.querySelector('input[type=file][multiple]')`),Boolean,{timeout:15000});
 await uploadLocalFiles(c.page,['/tmp/template-reference.png']);
 await waitForSignal(()=>c.evaluate(`(${readEditor.toString()})()`),s=>s.editor&&s.imageCount===1,{timeout:25000});
 await c.evaluate(`(${fillEditor.toString()})(${JSON.stringify({...task,tags:[]})})`);
 const topics=await fillNativeTopics(c,task.tags);
 await c.evaluate(`(()=>{const e=document.querySelector('#web input[placeholder*="标题"]');e.focus();e.select();})()`);await c.page.insertText(task.title);
 const readback=verifyEditor(await c.evaluate(`(${readEditor.toString()})()`),task);
 const ids=await c.evaluate(`(${uploadedDraftFileIds.toString()})()`);
 const result=await saveAndConfirmDraft(c.evaluate,task.title,{save:()=>clickDraftButton(c.page),acceptExisting:s=>!!verifyPersistedDraft(s,task,ids,{requireNativeTopics:true}),showDrafts:async s=>{verifyPersistedDraft(s,task,ids,{requireNativeTopics:true});if(await c.evaluate(`!!document.querySelector('[contenteditable=true]')`)){await c.page.selectTab(await c.page.newTab('https://creator.xiaohongshu.com/publish/publish?target=image'));await ready();}}});
 if(!result.saved||result.matches!==1)throw Error('草稿箱确认失败');
 const persisted=verifyPersistedDraft(result.persisted,task,ids,{requireNativeTopics:true});
 const report={saved:result.saved,title:task.title,topics,readback,persisted};await writeFile('outputs/native-topics/full-flow.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await c.close();}
