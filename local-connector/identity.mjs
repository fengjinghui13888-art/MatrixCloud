// Runs in the creator page. Never infer an identity from a generic ID or nickname.
export function readIdentity(){
 const text=document.body?.innerText||document.body?.textContent||'';
 const handle=(text.match(/小红书(?:账号|号)\s*[:：]?\s*([A-Za-z0-9_.-]+)/)||[])[1]||'';
 const name=(document.querySelector('.account-name, .user-info .name-box')?.textContent||'').trim();
 const followerLabel=[...document.querySelectorAll('span')].find(e=>e.textContent?.trim()==='粉丝数'&&e.parentElement?.querySelector('.numerical'));
 const followerText=followerLabel?.parentElement?.querySelector('.numerical')?.textContent?.trim()||'';
 const match=followerText.match(/^([\d,.]+)\s*(万|亿)?$/);
 const followers=match?Math.round(Number(match[1].replaceAll(',',''))*(match[2]==='万'?10000:match[2]==='亿'?1e8:1)):null;
 // The creator UI does not render the numeric account handle on every route
 // (notably note-manager and publish/publish).  The verified binding in the
 // workspace supplies that handle; here we only assert that this is a live,
 // non-login creator page with the visible account name.  Callers still
 // compare any handle that is present and always compare the account name.
 return {url:location.href,name,handle,followers,loggedIn:location.origin==='https://creator.xiaohongshu.com'&&!location.pathname.includes('login')&&!!name};
}

// Runs in the creator page.  Recent creator routes (including note-manager and
// publish/publish) omit the numeric account handle from the DOM.  Ask the
// creator service for the authenticated self record instead of treating a
// visible nickname as an account identifier.  The returned handle is still
// checked against the consumer web identity and the target account before any
// data is bound or imported.
export async function readCreatorIdentity(){
 const text=document.body?.innerText||document.body?.textContent||'';
 const domHandle=(text.match(/小红书(?:账号|号)\s*[:：]?\s*([A-Za-z0-9_.-]+)/)||[])[1]||'';
 const name=(document.querySelector('.account-name, .user-info .name-box')?.textContent||'').trim();
 const followerLabel=[...document.querySelectorAll('span')].find(e=>e.textContent?.trim()==='粉丝数'&&e.parentElement?.querySelector('.numerical'));
 const followerText=followerLabel?.parentElement?.querySelector('.numerical')?.textContent?.trim()||'';
 const match=followerText.match(/^([\d,.]+)\s*(万|亿)?$/);
 const followers=match?Math.round(Number(match[1].replaceAll(',',''))*(match[2]==='万'?10000:match[2]==='亿'?1e8:1)):null;
 const base={url:location.href,name,handle:domHandle,followers,loggedIn:location.origin==='https://creator.xiaohongshu.com'&&!location.pathname.includes('login')&&!!name};
 if(!base.loggedIn&&location.pathname.includes('login'))return {...base,status:'unknown'};
 const cached=window.__MATRIX_XHS_CREATOR_IDENTITY;
 if(cached?.value?.loggedIn&&Number.isFinite(cached.at)&&Date.now()-cached.at<5000)return {...cached.value,url:location.href};
 if(base.loggedIn&&domHandle){const value={...base,status:'authenticated',source:'creator-dom'};try{window.__MATRIX_XHS_CREATOR_IDENTITY={at:Date.now(),value};}catch{}return value;}
 const unknown={...base,loggedIn:false,status:'unknown'};
 const endpoints=['/api/galaxy/user/info','https://creator.xiaohongshu.com/api/galaxy/user/info'];
 let lastError='创作后台身份接口未返回完整的当前登录账号信息';
 for(const endpoint of endpoints){
  let response;
  try{response=await fetch(endpoint,{credentials:'include',headers:{Accept:'application/json'}});}catch{lastError='创作后台身份接口暂时无法访问';continue;}
  if([401,403,429].includes(response.status))return {...unknown,error:`创作后台身份接口返回 HTTP ${response.status}`};
  if(!response.ok){lastError=`创作后台身份接口返回 HTTP ${response.status}`;continue;}
  let payload;
  try{payload=await response.json();}catch{lastError='创作后台身份接口返回了无法读取的结果';continue;}
  const unwrap=value=>value?.value??value?._value??value;
  const root=unwrap(payload),data=unwrap(root?.data??root),self=unwrap(data?.userInfo??data?.user_info??data?.user??data);
  const handle=String(self?.redId??self?.red_id??data?.redId??data?.red_id??'');
  const userId=String(self?.userId??self?.user_id??data?.userId??data?.user_id??'');
  const apiName=String(self?.nickname??self?.nickName??self?.name??data?.nickname??data?.nickName??data?.name??'').trim();
  const loggedIn=root?.loggedIn??data?.loggedIn;
  const guest=self?.guest??data?.guest;
  if(guest===true||loggedIn===false) return {...unknown,status:'guest'};
  if(handle&&userId&&(loggedIn===undefined||loggedIn===true)){const value={...base,loggedIn:true,status:'authenticated',source:'creator-self-api',handle,userId,name:apiName||name};try{window.__MATRIX_XHS_CREATOR_IDENTITY={at:Date.now(),value};window.__MATRIX_XHS_CREATOR_IDENTITY_ENDPOINT=endpoint;}catch{}return value;}
  lastError='创作后台身份接口未返回完整的当前登录账号信息';
 }
 return {...unknown,error:lastError};
}

// Runs in the consumer web page. The creator console and consumer site use
// separate session checks, even when they share the same Chrome profile.
export async function readWebIdentity(){
 const unknown={url:location.href,status:'unknown',loggedIn:false,userId:'',redId:'',name:''};
 const identityFromPayload=(payload,source)=>{
  const unwrap=value=>value?.value??value?._value??value;
  const root=unwrap(payload);
  const data=unwrap(root?.data??root);
  const self=unwrap(data?.userInfo??data?.user_info??data?.user??data);
  const loggedIn=unwrap(root?.loggedIn??data?.loggedIn);
  const guest=self?.guest??data?.guest;
  const userId=String(self?.userId??self?.user_id??data?.userId??data?.user_id??'');
  const redId=String(self?.redId??self?.red_id??data?.redId??data?.red_id??'');
  const name=String(self?.nickname??self?.nickName??self?.name??data?.nickname??data?.nickName??data?.name??'');
  if(guest===true||loggedIn===false)return {...unknown,status:'guest',source};
  if(source==='web-self-state'){
   if(loggedIn!==true||!userId||!redId)return null;
   return {url:location.href,status:'authenticated',loggedIn:true,userId,redId,name,source};
  }
  if(source==='web-self-api'&&guest!==true&&userId&&redId)return {url:location.href,status:'authenticated',loggedIn:true,userId,redId,name,source};
  if(guest!==false||!userId||!redId)return null;
  return {url:location.href,status:'authenticated',loggedIn:true,userId,redId,name,source};
 };
 try{
  const state=window.__INITIAL_STATE__;
  const legacy=state?.user;
  if(legacy){
   const parsed=identityFromPayload(legacy,'web-self-state');
   if(parsed)return parsed;
   const legacyRoot=legacy?.value??legacy?._value??legacy;
   const legacyLoggedIn=legacyRoot?.loggedIn?.value??legacyRoot?.loggedIn;
   const legacySelf=legacyRoot?.userInfo?.value??legacyRoot?.userInfo;
   if(legacyLoggedIn===false||legacySelf?.guest===true)return {...unknown,status:'guest',source:'web-self-state'};
  }
  // Newer XHS builds no longer expose the self identity in INITIAL_STATE.
  // Read the page's own authenticated endpoint once, with browser cookies;
  // never use a viewed profile or a generic nickname as identity evidence.
  let lastError='网页版身份接口未返回完整的当前登录账号信息';
  const preferred=typeof window.__MATRIX_XHS_IDENTITY_ENDPOINT==='string'?window.__MATRIX_XHS_IDENTITY_ENDPOINT:'';
  const endpoints=[preferred,'/api/sns/web/v1/user/selfinfo','/api/sns/web/v2/user/me','https://edith.xiaohongshu.com/api/sns/web/v1/user/selfinfo','https://edith.xiaohongshu.com/api/sns/web/v2/user/me','https://edith.xiaohongshu.com/api/sns/web/v1/user/me','/api/sns/web/v1/user/me'].filter((endpoint,index,list)=>endpoint&&list.indexOf(endpoint)===index);
  for(const endpoint of endpoints){
   let response;
   try{response=await fetch(endpoint,{credentials:'include',headers:{Accept:'application/json'}});}catch{lastError='网页版身份接口暂时无法访问';continue;}
   if([401,403,429].includes(response.status))return {...unknown,error:`网页版身份接口返回 HTTP ${response.status}`};
   if(!response.ok){lastError=`网页版身份接口返回 HTTP ${response.status}`;continue;}
   const parsed=identityFromPayload(await response.json(),'web-self-api');
   if(parsed){try{window.__MATRIX_XHS_IDENTITY_ENDPOINT=endpoint;}catch{}return parsed;}
   lastError='网页版身份接口未返回完整的当前登录账号信息';
  }
  return {...unknown,error:lastError};
 }catch{return {...unknown,error:'网页版自身登录状态暂时无法读取'};}
}
