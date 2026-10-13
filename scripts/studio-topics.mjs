export function readNativeTopics(){
 return [...document.querySelectorAll('#web [contenteditable=true] a.tiptap-topic[data-topic]')].map(e=>{try{return JSON.parse(e.getAttribute('data-topic'));}catch{return {};}});
}
export function findTopicCandidate(name){
 const matches=[...document.querySelectorAll('.item[data-impression]')].filter(e=>{
  const r=e.getBoundingClientRect();
  if(!r.width||!r.height||e.closest('[contenteditable=true]'))return false;
  if(e.querySelector('.name')?.textContent?.trim()!=='#'+name)return false;
  try{return !!JSON.parse(e.getAttribute('data-impression')).tagTarget?.value?.tagId;}catch{return false;}
 });
 if(matches.length!==1)return null;
 const e=matches[0];e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();
 return {id:JSON.parse(e.getAttribute('data-impression')).tagTarget.value.tagId,x:r.x+r.width/2,y:r.y+r.height/2};
}
export async function fillNativeTopics({page,evaluate},tags,{timeout=8000}={}){
 if(!tags.length)return [];
 await new Promise(r=>setTimeout(r,100));
 await evaluate(`(()=>{const b=document.querySelector('#web [contenteditable=true]');if(!b)throw Error('未找到正文');b.focus();const r=document.createRange();r.selectNodeContents(b.lastElementChild||b);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new Event('selectionchange'));return true;})()`);
 await new Promise(r=>setTimeout(r,100));
 await evaluate(`document.execCommand('insertParagraph')`);
 const selected=[];
 for(const name of tags){
  await page.insertText('#');await page.insertText(name);
  const deadline=Date.now()+timeout;let candidate;
  do{candidate=await evaluate(`(${findTopicCandidate.toString()})(${JSON.stringify(name)})`);if(candidate)break;await new Promise(r=>setTimeout(r,200));}while(Date.now()<deadline);
  if(!candidate)throw Error(`未找到小红书话题「${name}」的同名候选，请修改标签或在当前编辑器手动选择；尚未确认保存成功`);
  await page.nativeClick(candidate.x,candidate.y);
  let actual;const confirmUntil=Date.now()+3000;
  do{actual=await evaluate(`(${readNativeTopics.toString()})()`);if(actual.some(t=>t.name===name&&t.id===candidate.id))break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<confirmUntil);
  if(!actual.some(t=>t.name===name&&t.id===candidate.id))throw Error(`话题「${name}」未形成平台话题链接，已停止保存`);
  selected.push({name,id:candidate.id});
 }
 return selected;
}
