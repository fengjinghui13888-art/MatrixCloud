// Save only through the visible draft action; never invoke the publish action.
export function saveDraft(){
 const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
 for(const host of document.querySelectorAll('xhs-publish-btn')){
  if(!visible(host))continue;
  // Current creator UI implements its visible 暂存离开 control in a closed shadow root.
  for(const name of ['_onSave','_onSaveDraft','_onDraft'])if(typeof host[name]==='function'){host[name]();return {ok:true};}
 }
 const button=[...document.querySelectorAll('button,[role="button"]')].find(e=>visible(e)&&!e.disabled&&['暂存离开','存草稿','保存草稿'].includes((e.innerText??e.textContent??'').trim()));
 if(!button)throw Error('未找到暂存离开按钮，内容保留在创作页');
 button.click();return {ok:true};
}
export function inspectDraftList(title){
 const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
 const drawer=[...document.querySelectorAll('.draft-drawer')].find(visible);
 const list=drawer?.querySelector('.draft-list');
 const rows=[...(list?.querySelectorAll('.draft-item[data-draft-id][data-draft-type="image"]')??[])].filter(e=>visible(e)&&e.querySelector('.draft-title-text')?.textContent.trim()===title);
 return {matches:rows.length,draftIds:rows.map(e=>e.getAttribute('data-draft-id')),drawer:!!drawer,saved:document.body.innerText.includes('保存成功'),text:drawer?.innerText?.slice(-5000)??''};
}

export function openImageDrafts(){
 const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
 const drawer=[...document.querySelectorAll('.draft-drawer')].find(visible);
 if(!drawer){
  const entry=[...document.querySelectorAll('body *')].find(e=>visible(e)&&!e.children.length&&/^草稿箱\(\d+\)$/.test(e.textContent.trim()));
  entry?.click();return !!entry;
 }
 const tab=[...drawer.querySelectorAll('.tab-item')].find(e=>/^图文笔记\(\d+\)$/.test(e.textContent.trim()));
 if(tab&&!tab.classList.contains('active'))tab.click();
 return !!tab;
}
