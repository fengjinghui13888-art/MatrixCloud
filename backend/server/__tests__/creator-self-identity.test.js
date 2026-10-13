import {readCreatorIdentity} from '../../../local-connector/identity.mjs';

const originalLocation=globalThis.location;

beforeEach(()=>{
 document.body.innerHTML='<div class="account-name">FJINGHUI</div>';
 vi.stubGlobal('location',{origin:'https://creator.xiaohongshu.com',pathname:'/new/note-manager',href:'https://creator.xiaohongshu.com/new/note-manager'});
});

afterEach(()=>{
 delete window.__MATRIX_XHS_CREATOR_IDENTITY;
 delete window.__MATRIX_XHS_CREATOR_IDENTITY_ENDPOINT;
 vi.unstubAllGlobals();
 Object.defineProperty(globalThis,'location',{configurable:true,value:originalLocation});
});

test('creator identity falls back to the authenticated creator endpoint when the page omits the handle',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,json:async()=>({data:{userId:'u1',redId:'11839495135',nickname:'FJINGHUI'}})})));
 await expect(readCreatorIdentity()).resolves.toMatchObject({loggedIn:true,handle:'11839495135',userId:'u1',name:'FJINGHUI',source:'creator-self-api'});
 await expect(readCreatorIdentity()).resolves.toMatchObject({loggedIn:true,handle:'11839495135',source:'creator-self-api'});
 expect(fetch).toHaveBeenCalledWith('/api/galaxy/user/info',{credentials:'include',headers:{Accept:'application/json'}});
 expect(fetch).toHaveBeenCalledOnce();
});

test('creator identity never treats a rejected endpoint as a logged-in account',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:false,status:403,json:async()=>({})})));
 await expect(readCreatorIdentity()).resolves.toMatchObject({loggedIn:false,status:'unknown'});
});
