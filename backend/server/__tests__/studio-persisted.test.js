import {it,expect,vi} from 'vitest';import {readPersistedImageDraft,verifyPersistedDraft} from '../../../scripts/studio-persisted-draft.mjs';import {refreshPlatformDraftList} from '../../../scripts/studio-refresh-drafts.mjs';
it('retries a stalled read but never reports an unreadable store as an empty draft box',async()=>{
 vi.stubGlobal('indexedDB',{databases:vi.fn().mockImplementationOnce(()=>new Promise(()=>{})).mockResolvedValue([])});
 try{expect(await readPersistedImageDraft('test',{timeoutMs:10})).toEqual({available:false,matches:0});
 indexedDB.databases.mockImplementation(()=>new Promise(()=>{}));
 await expect(readPersistedImageDraft('test',{timeoutMs:10})).rejects.toThrow('草稿库枚举超时');
 }finally{vi.unstubAllGlobals();}
});
it('closes a database connection arriving after its deadline',async()=>{
 const request={},db={close:vi.fn()};vi.stubGlobal('indexedDB',{databases:async()=>[{name:'draft-database-v1'}],open:()=>request});
 try{await expect(readPersistedImageDraft('test',{timeoutMs:10,attempts:1})).rejects.toThrow('草稿库打开超时');request.result=db;request.onsuccess();expect(db.close).toHaveBeenCalledOnce();}finally{vi.unstubAllGlobals();}
});
it('only recovers a unique matching draft with uploaded images',()=>{
 const task={title:'title',body:'body',tags:['tag'],images:['https://example.test/image']};
 const snapshot={available:true,matches:1,records:[{draftId:'d',title:'title',body:'body',tags:[{name:'tag'}],images:[{fileId:'image-id',status:2}]}]};
 expect(verifyPersistedDraft(snapshot,task,['image-id'])).toMatchObject({draftId:'d',imageCount:1});
 expect(()=>verifyPersistedDraft(snapshot,{...task,body:'other'})).toThrow('不一致');
 expect(()=>verifyPersistedDraft({...snapshot,records:[{...snapshot.records[0],images:[{fileId:'',status:1}]}]},task)).toThrow();
 expect(verifyPersistedDraft({...snapshot,matches:2},task)).toBeNull();
 expect(()=>verifyPersistedDraft(snapshot,task,['different-image'])).toThrow('图片与本次上传回读不一致');
});
it('verifies platform paragraph serialization and exact inline hashtag suffix without ignoring content changes',()=>{
 const task={title:'title',body:'first\n\nsecond',tags:['收纳','生活'],images:['image']};
 const snapshot={available:true,matches:1,records:[{draftId:'d',title:'title',body:'first\n\t\nsecond\n#收纳 #生活',tags:[],images:[{fileId:'file',status:2}]}]};
 expect(verifyPersistedDraft(snapshot,task,['file'])).toMatchObject({body:task.body,tags:task.tags});
 for(const body of ['first\n\t\nsecond\n#收纳 #其他','first\n\t\nsecond changed\n#收纳 #生活','first\nsecond\n#收纳 #生活'])expect(()=>verifyPersistedDraft({...snapshot,records:[{...snapshot.records[0],body}]},task,['file'])).toThrow('不一致');
 expect(()=>verifyPersistedDraft(snapshot,task,['other'])).toThrow('图片');
});
it('refreshes only the known platform list loading hook, never an active editor',async()=>{
 document.body.innerHTML='<div id="web"></div>';localStorage.setItem('snsWebPublishCurrentUser','uid');const mounted=vi.fn(async()=>{}),element=document.getElementById('web');element.__vue_app__={};element._vnode={component:{type:{__name:'DraftBox'},render:()=> 'draft-title-box',isMounted:true,m:[mounted]}};
 expect(await refreshPlatformDraftList()).toEqual({refreshed:true});expect(mounted).toHaveBeenCalledTimes(1);
 element.innerHTML='<input placeholder="输入标题">';expect(await refreshPlatformDraftList()).toMatchObject({refreshed:false,reason:'editor-active'});expect(mounted).toHaveBeenCalledTimes(1);
 document.body.innerHTML='';localStorage.clear();
});
