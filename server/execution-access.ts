import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes} from 'node:crypto';
const context=new AsyncLocalStorage<string>();
type Grant={workspace:string;expires:number;taskId?:string;accountId?:string;valid?:()=>boolean;validate?:()=>Promise<boolean>};
const grants=new Map<string,Grant>();
export function executionGrant(token:string){const grant=grants.get(token);if(!grant)return null;if(grant.expires<Date.now()||grant.valid&&!grant.valid()){grants.delete(token);return null;}return grant;}
export async function validateExecutionGrant(token:string){const g=executionGrant(token);if(g?.validate&&!await g.validate()){grants.delete(token);return null;}return g;}
export function executionWorkspace(token:string){return executionGrant(token)?.workspace??null;}
export function withExecutionAccess<T>(workspace:string,next:()=>T){return context.run(workspace,next);}
export function executionToken(task?:{taskId:string;accountId:string;valid?:()=>boolean;validate?:()=>Promise<boolean>}){
 const workspace=context.getStore();if(!workspace)return process.env.STUDIO_TOKEN;
 for(const [key,g] of grants)if(g.expires<Date.now())grants.delete(key);
 const token=randomBytes(32).toString('hex');grants.set(token,{workspace,expires:Date.now()+15*60*1000,...task});return token;
}
export function executionRequestAllowed(token:string,method:string,path:string){
 const grant=executionGrant(token);if(!grant)return false;if(!grant.taskId)return true;
 return method==='GET'&&(path==='/api/operations'||path==='/api/studio/'+grant.taskId||new RegExp('^/api/studio/'+grant.taskId+'/media/[a-f0-9]{64}\\.(png|jpg|webp)$').test(path))
   ||method==='POST'&&['claim','progress','receipt'].some(action=>path===`/api/studio/${grant.taskId}/${action}`);
}
