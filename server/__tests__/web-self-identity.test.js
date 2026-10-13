import {readWebIdentity} from '../../local-connector/identity.mjs';
afterEach(()=>{delete window.__INITIAL_STATE__;vi.unstubAllGlobals();});
test('uses authenticated self state without manually calling a rejected API',async()=>{
 window.__INITIAL_STATE__={user:{loggedIn:{value:true},userInfo:{value:{userId:'self-id',redId:'11839495135',nickname:'Self'}}}};
 const fetcher=vi.fn(async()=>({ok:false,status:406}));vi.stubGlobal('fetch',fetcher);
 expect(await readWebIdentity()).toMatchObject({loggedIn:true,userId:'self-id',redId:'11839495135',name:'Self'});expect(fetcher).not.toHaveBeenCalled();
});
test('viewed profile is never substituted for self identity',async()=>{
 window.__INITIAL_STATE__={user:{loggedIn:false,userInfo:{},userPageData:{basicInfo:{userId:'other',redId:'11839495135'}}}};
 vi.stubGlobal('fetch',vi.fn());expect((await readWebIdentity()).loggedIn).toBe(false);expect(fetch).not.toHaveBeenCalled();
});
test('incomplete legacy state falls back to the authenticated self endpoint',async()=>{
 window.__INITIAL_STATE__={user:{loggedIn:true,userInfo:{nickname:'Same name'}}};
 const fetcher=vi.fn(async()=>({ok:true,status:200,json:async()=>({data:{guest:false,user_id:'self-id',red_id:'11839495135',nickname:'Self'}})}));vi.stubGlobal('fetch',fetcher);
 expect(await readWebIdentity()).toMatchObject({loggedIn:true,userId:'self-id',redId:'11839495135'});expect(fetcher).toHaveBeenCalledOnce();
});
test('new web build falls back to its authenticated self endpoint',async()=>{
 delete window.__INITIAL_STATE__;
 const fetcher=vi.fn(async()=>({ok:true,status:200,json:async()=>({success:true,data:{guest:false,user_id:'self-id',red_id:'11839495135',nickname:'Self'}})}));
 vi.stubGlobal('fetch',fetcher);
 await expect(readWebIdentity()).resolves.toMatchObject({loggedIn:true,userId:'self-id',redId:'11839495135',source:'web-self-api'});
 expect(fetcher).toHaveBeenCalledWith('/api/sns/web/v1/user/selfinfo',{credentials:'include',headers:{Accept:'application/json'}});
});
test('older web build falls back to same-origin v2 identity',async()=>{
 delete window.__INITIAL_STATE__;
 const fetcher=vi.fn()
  .mockResolvedValueOnce({ok:false,status:404})
  .mockResolvedValueOnce({ok:true,status:200,json:async()=>({data:{user_id:'self-id',red_id:'11839495135',nickname:'Self'}})});
 vi.stubGlobal('fetch',fetcher);
 await expect(readWebIdentity()).resolves.toMatchObject({loggedIn:true,userId:'self-id',redId:'11839495135'});
 expect(fetcher.mock.calls[1][0]).toBe('/api/sns/web/v2/user/me');
});
test('self endpoint guest response never confirms a login',async()=>{
 delete window.__INITIAL_STATE__;
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,json:async()=>({success:true,data:{guest:true,user_id:'self-id',red_id:'11839495135'}})})));
 await expect(readWebIdentity()).resolves.toMatchObject({loggedIn:false,status:'guest'});
});
