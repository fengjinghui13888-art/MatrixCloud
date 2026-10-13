// Some creator builds mount DraftBox before userInfo is ready and never reload
// its list. Re-run that component's own read-only loading hook after identity is
// established; never synthesize draft rows or write to the platform database.
export async function refreshPlatformDraftList(){
 if(document.querySelector('#web input[placeholder*="标题"],.tiptap[contenteditable="true"]'))return {refreshed:false,reason:'editor-active'};
 if(!localStorage.getItem('snsWebPublishCurrentUser'))return {refreshed:false,reason:'identity-missing'};
 const components=[],seen=new Set();
 const walk=v=>{if(!v||seen.has(v))return;seen.add(v);if(v.component){const c=v.component;if(c.type?.__name==='DraftBox'&&c.render?.toString().includes('draft-title-box')&&c.isMounted&&c.m?.length===1)components.push(c);walk(c.subTree);}if(Array.isArray(v.children))v.children.forEach(walk);if(Array.isArray(v.dynamicChildren))v.dynamicChildren.forEach(walk);walk(v.suspense?.activeBranch);walk(v.ssContent);};
 for(const e of document.querySelectorAll('*'))if(e.__vue_app__)walk(e._vnode);
 if(components.length!==1)return {refreshed:false,reason:'unsupported-platform-version'};
 await components[0].m[0]();return {refreshed:true};
}
