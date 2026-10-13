import {matchesNativeTopicText} from './studio-copy.mjs';
// Page-visible evidence only. Never count avatars, recommendations or file-input values.
export function readEditor(){
 const root=document.querySelector('#web');
 const title=root?.querySelector('input[placeholder*="标题"]');
 const body=root?.querySelector('[contenteditable=true]');
 const copy=body?.cloneNode(true);copy?.querySelectorAll('.content-hide').forEach(e=>e.remove());
 const topics=[...(body?.querySelectorAll('a.tiptap-topic[data-topic]')??[])].map(e=>{try{return JSON.parse(e.getAttribute('data-topic'));}catch{return {};}});
 const images=[...(root?.querySelectorAll('.format-img img.preview')??[])];
 return {topics,title:title?.value??'',text:body?.classList.contains('ProseMirror')?[...copy.children].map(p=>p.textContent??'').join('\n'):(body?.innerText??''),imageCount:images.filter(i=>i.complete&&i.naturalWidth>0).length,pendingImageCount:root?.querySelectorAll('.format-img').length??0,editor:!!title&&!!body,url:location.href};
}
export function readTitlePreview(title){
 const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
 return [...document.querySelectorAll('#web .title, #web .ellipsis.small')].some(e=>visible(e)&&e.textContent.trim()===title);
}
export function fillEditor(task){
 const root=document.querySelector('#web');
 const title=root?.querySelector('input[placeholder*="标题"]');
 const body=root?.querySelector('[contenteditable=true]');
 if(!title||!body)throw Error('未找到标题或正文输入框');
 const text=task.body+(task.tags.length?'\n'+task.tags.map(t=>'#'+t).join(' '):'');
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(title,task.title);
 title.dispatchEvent(new Event('input',{bubbles:true}));
 title.dispatchEvent(new Event('change',{bubbles:true}));
 body.focus();
 body.replaceChildren(...text.split('\n').map(line=>{const p=document.createElement('p');if(line)p.textContent=line;else p.append(document.createElement('br'));return p;}));
 body.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
 return true;
}
export function verifySavedDraft(actual,task){
 if(actual.title!==task.title||actual.body!==task.body||actual.imageCount!==task.images.length)throw Error('草稿箱回读与审核稿不一致');
 return true;
}
export function verifyEditor(actual,task){
 if(actual.topics&&task.tags.length&&(actual.topics.length!==task.tags.length||actual.topics.some((t,i)=>!t.id||!t.link||t.name!==task.tags[i])))throw Error('话题未全部关联平台话题，请选择真实候选后再保存');
 if(!actual.editor)throw Error('未找到标题或正文输入框');
 if(actual.title!==task.title)throw Error('页面标题与审核稿不一致');
 const suffix=task.tags.length?'\n'+task.tags.map(t=>'#'+t).join(' '):'';
 // Preserve paragraph boundaries and whitespace. Receipt must match the approved revision exactly.
 const canonical=s=>s.replace(/\u00a0/g,' ').replace(/[ \t]+$/gm,'').replace(/\r/g,'').replace(/\n{3,}/g,'\n\n').trim();
 const text=canonical(actual.text),approvedBody=canonical(task.body);
 let copyMatches=text===canonical(task.body+suffix);
 if(actual.topics&&task.tags.length){
  // Native topic chips insert NBSPs and may be adjacent or wrap onto another
  // line. Their IDs/names were checked above. Allow only separators between
  // those exact chips; never normalize whitespace inside the approved body.
  copyMatches=matchesNativeTopicText(text,approvedBody,task.tags);
 }
 if(!copyMatches)throw Error('页面正文/标签与审核稿不一致，尚未确认草稿保存');
 if(actual.imageCount!==task.images.length)throw Error(`真实媒体预览数量不一致：要求 ${task.images.length}，实际 ${actual.imageCount}`);
 return {title:actual.title,body:task.body,tags:[...task.tags],imageCount:actual.imageCount};
}
