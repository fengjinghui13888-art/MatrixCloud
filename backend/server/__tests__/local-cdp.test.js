import {readFileSync} from 'node:fs';
import {readIdentity,readWebIdentity} from '../../../local-connector/identity.mjs';
test('blank and login pages never become connected',()=>{
 document.body.innerHTML='';expect(readIdentity().loggedIn).toBe(false);
 document.body.innerHTML='<div>扫码登录</div>';expect(readIdentity().loggedIn).toBe(false);
});
test('identity requires exact visible account identifier and name',()=>{
 document.body.innerHTML='<div class="account-name">FJINGHUI</div><div>小红书账号: 11839495135</div>';
 expect(readIdentity()).toMatchObject({handle:'11839495135',name:'FJINGHUI'});
});
test('web identity reads authenticated self state',async()=>{
 window.__INITIAL_STATE__={user:{loggedIn:true,userInfo:{guest:false,userId:'u1',redId:'11839495135',nickname:'FJINGHUI'}}};
 try{await expect(readWebIdentity()).resolves.toMatchObject({loggedIn:true,userId:'u1',redId:'11839495135',name:'FJINGHUI'});}finally{delete window.__INITIAL_STATE__;}
});
test('web identity treats guest self state as logged out',async()=>{
 window.__INITIAL_STATE__={user:{loggedIn:false,userInfo:{guest:true}}};
 try{await expect(readWebIdentity()).resolves.toMatchObject({loggedIn:false});}finally{delete window.__INITIAL_STATE__;}
});
