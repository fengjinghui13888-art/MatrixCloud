import {filterKnownSyncRecords,verifiedIncrementalNoteOwnership} from '../../../scripts/xhs-playwright.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';

test('incremental collection excludes already stored comments and messages',()=>{
 const result=filterKnownSyncRecords({comments:[{id:'old',noteId:'n'},{id:'new',noteId:'n'}],messages:[{id:'m-old'},{id:'m-new'}]},['old'],['m-old']);
 expect(result).toEqual({comments:[{id:'new',noteId:'n'}],messages:[{id:'m-new'}]});
});

test('old target-account notes establish incremental ownership only after both identities match',()=>{
 const input={mode:'incremental',target:{id:'a',handle:'tester'},creatorIdentity:{redId:'tester',userId:'self'},webIdentity:{red_id:'tester',user_id:'self'},knownNotes:[{id:'old-owned',accountId:'a'},{id:'foreign',accountId:'b'},{id:'unscoped'}]};
 expect([...verifiedIncrementalNoteOwnership(input)]).toEqual(['old-owned']);
 expect([...verifiedIncrementalNoteOwnership({...input,mode:undefined})]).toEqual([]);
 expect([...verifiedIncrementalNoteOwnership({...input,creatorIdentity:{redId:'other',userId:'self'}})]).toEqual([]);
 expect([...verifiedIncrementalNoteOwnership({...input,webIdentity:{red_id:'tester',user_id:'other'}})]).toEqual([]);
 expect([...verifiedIncrementalNoteOwnership({...input,webIdentity:{...input.webIdentity,guest:true}})]).toEqual([]);
});

test('incremental notification collection includes a new comment on a stored older owned note',async()=>{
 const root=mkdtempSync(join(tmpdir(),'incremental-owned-'));writeFileSync(join(root,'connector-token'),'fixture-token');let receive;
 const emit=(path,data)=>receive({path,url:'https://www.xiaohongshu.com'+path,body:{data}});
 const creator={url:()=> 'https://creator.xiaohongshu.com/new/home',bringToFront:async()=>{},evaluate:async()=>null,locator:()=>({innerText:async()=>''}),goto:async url=>{emit('/api/galaxy/user/info',{redId:'tester',userId:'self'});if(url.endsWith('/note-manager'))emit('/api/sns/web/v1/note/user/posted',{notes:[{id:'recent'}],has_more:false});}};
 const web={url:()=> 'https://www.xiaohongshu.com/notification',bringToFront:async()=>{},locator:()=>({innerText:async()=>''}),goto:async url=>{emit('/api/sns/web/v1/user/selfinfo',{red_id:'tester',user_id:'self'});if(url.endsWith('/notification'))emit('/api/sns/web/v1/you/mentions',{has_more:false,items:[{comment_info:{id:'fresh-comment',content:'new reply'},item_info:{id:'old-owned'},user_info:{nickname:'author'}}]});if(url.endsWith('/chat'))emit('/api/im/v3/chats',{chats:[],next_ts:-1});}};
 const context={setDefaultTimeout:()=>{},setDefaultNavigationTimeout:()=>{},pages:()=>[creator,web],route:async()=>{}},browser={contexts:()=>[context],close:async()=>{}};
 vi.resetModules();vi.stubEnv('LOCAL_CONNECTOR_ROOT',root);vi.stubGlobal('fetch',async()=>({ok:true,json:async()=>({debugPort:1})}));
 vi.doMock('playwright-core',()=>({chromium:{connectOverCDP:async()=>browser}}));vi.doMock('../../../scripts/execution-guard.mjs',()=>({executionGuard:()=>({check:()=>{},halt:()=>{}})}));vi.doMock('../../../scripts/action-pacing.mjs',()=>({createActionPacer:()=>async()=>{}}));vi.doMock('../../../scripts/xhs-network.mjs',()=>({captureNetwork:(_context,fn)=>(receive=fn,{assert:()=>{},flush:async()=>{},stop:()=>{},evidence:[],errors:[]})}));
 try{const {collectWithPlaywright}=await import('../../../scripts/xhs-playwright.mjs');const options={profile:'local:a',target:{id:'a',handle:'tester'},knownNotes:[{id:'recent',accountId:'a',summary:'known',images:['image']},{id:'old-owned',accountId:'a',summary:'old',images:['image']}],mode:'incremental'};
  const result=await collectWithPlaywright(options);expect(result.comments.map(c=>[c.id,c.noteId,c.accountId])).toEqual([['fresh-comment','old-owned','a']]);
  const manual=await collectWithPlaywright({...options,mode:undefined});expect(manual.comments).toEqual([]);
 }finally{for(const mod of ['playwright-core','../../../scripts/execution-guard.mjs','../../../scripts/action-pacing.mjs','../../../scripts/xhs-network.mjs'])vi.doUnmock(mod);vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetModules();rmSync(root,{recursive:true,force:true});}
});
