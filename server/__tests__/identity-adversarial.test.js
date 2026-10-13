import {readIdentity,readWebIdentity} from '../../local-connector/identity.mjs';
afterEach(()=>vi.unstubAllGlobals());
test('unrelated long numbers must not identify an account',()=>{document.body.innerHTML='<div class="account-name">A</div><div>订单 12345678901</div>';expect(readIdentity().handle).toBe('');});
test('HTTP rejection is unknown, never successful login',async()=>{vi.stubGlobal('fetch',async()=>({ok:false,status:403,json:async()=>({data:{guest:false,user_id:'u',red_id:'123'}})}));expect(await readWebIdentity()).toMatchObject({loggedIn:false,status:'unknown'});});
test('ambiguous API response is unknown, not confirmed guest',async()=>{vi.stubGlobal('fetch',async()=>({ok:true,json:async()=>({code:-1,message:'blocked'})}));expect(await readWebIdentity()).toMatchObject({loggedIn:false,status:'unknown'});});
