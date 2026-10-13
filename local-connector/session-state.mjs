import {readCreatorIdentity,readWebIdentity} from './identity.mjs';
export async function readSession(s,{connectPage,findExistingWebPage,findOrOpenWebPage}){
 const connection=await connectPage(s.debugPort);
 try{
  const creator=await connection.evaluate(`(${readCreatorIdentity.toString()})()`);
  if(!creator.loggedIn)return {loggedIn:false,creatorLoggedIn:false,webLoggedIn:false,stage:'creator',creator,web:null,message:'等待扫码登录创作服务平台'};
  const webId=await (findExistingWebPage??findOrOpenWebPage)(s);if(!webId)return {loggedIn:false,creatorLoggedIn:true,webLoggedIn:false,stage:'web',creator,web:null,message:'请主动打开网页版登录页后继续登录'};await connection.page.selectTab(webId);
  const web=await connection.evaluate(`(${readWebIdentity.toString()})()`);
  if(!web.loggedIn){
   return {loggedIn:false,creatorLoggedIn:true,webLoggedIn:false,stage:'web',creator,web,message:'创作平台已登录，已打开小红书网页版，请在浏览器中继续扫码'};
  }
  const confirmed=!!creator.handle&&!!web.redId;
  const mismatch=confirmed&&creator.handle.toLowerCase()!==web.redId.toLowerCase();
  return {loggedIn:confirmed&&!mismatch,creatorLoggedIn:true,webLoggedIn:true,stage:!confirmed?'verifying':mismatch?'mismatch':'ready',creator,web,creatorHandle:creator.handle,webHandle:web.redId,handle:creator.handle,name:creator.name||web.name,followers:creator.followers,message:mismatch?'创作平台与网页版账号不一致':''};
 }finally{await connection.close();}
}
