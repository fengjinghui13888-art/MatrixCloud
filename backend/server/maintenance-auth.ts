import {createHash,randomBytes,randomUUID,scryptSync,timingSafeEqual} from 'node:crypto';
import type {Response} from 'express';
import type {OAuthServerProvider,AuthorizationParams} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type {OAuthClientInformationFull,OAuthTokenRevocationRequest} from '@modelcontextprotocol/sdk/shared/auth.js';
import {InvalidGrantError,InvalidTokenError,InvalidScopeError} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {MaintenanceState} from './maintenance-state';
export const maintenanceScopes=['maintenance:read','maintenance:write','maintenance:release','maintenance:cleanup'];
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const secret=()=>randomBytes(32).toString('base64url');
export const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function passwordHash(password:string){if(password.length<16)throw Error('维护密码至少16个字符');const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,32).toString('hex');}
export function passwordMatches(password:string,stored:string){try{const [salt,digest]=stored.split(':');const expected=Buffer.from(digest,'hex'),actual=scryptSync(password,salt,32);return expected.length===actual.length&&timingSafeEqual(expected,actual);}catch{return false;}}
type Pending={id:string;clientId:string;redirectUri:string;scopes:string[];challenge:string;state?:string;resource:string;expires:number};
export class MaintenanceAuth implements OAuthServerProvider {
 // The SDK must pass the verifier through; this provider validates PKCE itself.
 readonly skipLocalPkceValidation=true;
 readonly state:MaintenanceState;
 readonly clientsStore;
 constructor(readonly options:{root:string;resource:string;adminHash:string;clients:OAuthClientInformationFull[];now?:()=>number}){
  this.state=new MaintenanceState(options.root);
  this.clientsStore={getClient:async(id:string)=>options.clients.find(c=>c.client_id===id)};
 }
 private now(){return (this.options.now??Date.now)();}
 verifyAdministrator(password:string){return passwordMatches(password,this.options.adminHash);}
 begin(client:OAuthClientInformationFull,p:AuthorizationParams){
  this.state.pruneExpiring(['pending','code','approval-form'],this.now());
  if(this.state.list('pending').length>=200)throw new InvalidGrantError('授权请求过多，请稍后重试');
  const registered=this.options.clients.find(c=>c.client_id===client.client_id);
  const validRedirect=registered?.redirect_uris.some(uri=>{
   if(uri===p.redirectUri)return true;
   const a=new URL(uri),b=new URL(p.redirectUri);
   return a.protocol==='http:'&&a.hostname==='127.0.0.1'&&b.protocol===a.protocol&&b.hostname===a.hostname&&b.pathname===a.pathname&&!b.search&&!b.hash&&!b.username&&!b.password;
  });
  if(!registered||!validRedirect||p.resource?.href!==this.options.resource||!/^[\w-]{43,128}$/.test(p.codeChallenge))throw new InvalidGrantError('授权客户端、回调或资源无效');
  const scopes=p.scopes?.length?p.scopes:['maintenance:read'];if(scopes.some(s=>!maintenanceScopes.includes(s)))throw new InvalidScopeError('权限范围无效');
  const pending:Pending={id:secret(),clientId:client.client_id,redirectUri:p.redirectUri,scopes,challenge:p.codeChallenge,state:p.state,resource:this.options.resource,expires:this.now()+300000};
  this.state.put('pending',hash(pending.id),pending);return pending;
 }
 async authorize(client:OAuthClientInformationFull,p:AuthorizationParams,res:Response){const pending=this.begin(client,p);res.redirect('/maintenance/consent?id='+encodeURIComponent(pending.id));}
 pending(id:string){const p=this.state.get<Pending>('pending',hash(id));if(!p||p.expires<this.now())throw new InvalidGrantError('授权请求已过期');return p;}
 consent(id:string,password:string){
  const p=this.pending(id);if(!this.verifyAdministrator(password)){this.state.audit('unknown','oauth-login',p.clientId,'denied');throw Error('管理员验证失败');}
  const code=secret();this.state.remove('pending',hash(id));this.state.put('code',hash(code),p);
  this.state.audit('owner','oauth-consent',p.clientId,p.scopes.join(' '));
  const url=new URL(p.redirectUri);url.searchParams.set('code',code);if(p.state)url.searchParams.set('state',p.state);url.searchParams.set('iss',new URL(new URL(this.options.resource).origin).href);return url.href;
 }
 async challengeForAuthorizationCode(client:OAuthClientInformationFull,code:string){const p=this.state.get<Pending>('code',hash(code));if(!p||p.clientId!==client.client_id||p.expires<this.now())throw new InvalidGrantError('授权码无效');return p.challenge;}
 private issue(clientId:string,scopes:string[],family:string){const access=secret(),refresh=secret(),expires=this.now()+900000;
  const payload={clientId,scopes,expiresAt:Math.floor(expires/1000),resource:this.options.resource,extra:{actor:'owner',family}};
  this.state.put('access',hash(access),payload);this.state.put('refresh',hash(refresh),{clientId,scopes,family,expires:this.now()+7*86400000});
  return {access_token:access,token_type:'Bearer',expires_in:900,refresh_token:refresh,scope:scopes.join(' ')};
 }
 async exchangeAuthorizationCode(client:OAuthClientInformationFull,code:string,verifier?:string,redirect?:string,resource?:URL){
  const p=this.state.get<Pending>('code',hash(code));
  if(!p||p.expires<this.now()||p.clientId!==client.client_id||redirect!==p.redirectUri||resource?.href!==p.resource||!verifier||createHash('sha256').update(verifier).digest('base64url')!==p.challenge)throw new InvalidGrantError('授权码或PKCE校验失败');
  this.state.remove('code',hash(code));return this.issue(p.clientId,p.scopes,randomUUID());
 }
 async exchangeRefreshToken(client:OAuthClientInformationFull,token:string,scopes?:string[],resource?:URL){
  const r=this.state.get('refresh',hash(token));if(!r||r.clientId!==client.client_id||r.expires<this.now()||this.state.get('revoked',r.family)||resource?.href!==this.options.resource)throw new InvalidGrantError('刷新凭证无效');
  if(scopes?.some(s=>!r.scopes.includes(s)))throw new InvalidScopeError('不能扩大权限');
  this.state.remove('refresh',hash(token));return this.issue(r.clientId,scopes??r.scopes,r.family);
 }
 async verifyAccessToken(token:string){const r=this.state.get('access',hash(token));if(!r||r.expiresAt*1000<this.now()||this.state.get('revoked',r.extra.family))throw new InvalidTokenError('Token expired or revoked');return {...r,token};}
 async revokeToken(client:OAuthClientInformationFull,request:OAuthTokenRevocationRequest){const r=this.state.get('access',hash(request.token))??this.state.get('refresh',hash(request.token));if(r?.clientId===client.client_id){this.state.put('revoked',r.extra?.family??r.family,{at:this.now()});this.state.audit('owner','oauth-revoke',client.client_id,'revoked');}}
}
