import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { scriptPath } from './runtime-paths.js';
import { randomUUID } from 'node:crypto';
import type { Store } from './store';

type JobState = { id:string; status:'starting'|'waiting_scan'|'authenticated'|'failed'|'cancelled'; message:string; image:string; detected?:string; detectedName?:string; detectedHandle?:string; profile:string; accountWritten?:boolean };

export function createQrLogin(dir:string, store:Store){
  const root=join(dir,'qr-logins');mkdirSync(root,{recursive:true,mode:0o700});
  const jobs=new Map<string,{statePath:string;child:ReturnType<typeof spawn>}>();
  const read=(id:string):JobState|null=>{const path=join(root,id+'.json');if(!existsSync(path))return null;try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}};
  const start=(input:{profile?:string;cli?:string})=>{
    const profile=input.profile || process.env.MATRIX_PROFILE || '';
    if(!profile)throw Error('当前工作台尚未配置浏览器桥接，无法直接扫码');
    const id=randomUUID();const statePath=join(root,id+'.json');const image=join(root,id+'.png');
    const state:JobState={id,status:'starting',message:'正在打开小红书登录页…',image:id+'.png',profile};
    writeFileSync(statePath,JSON.stringify(state),{mode:0o600});
    const script=scriptPath('scripts', 'xhs-qr-login.mjs');
    const child=spawn(process.execPath,[script,id],{stdio:['ignore','ignore','ignore'],env:{...process.env,QR_STATE_PATH:statePath,QR_IMAGE_PATH:image,QR_PROFILE:profile,BROWSER_BRIDGE_NODE:input.cli??process.env.BROWSER_BRIDGE_NODE??''}});
    jobs.set(id,{statePath,child});
    child.once('exit',()=>jobs.delete(id));
    return read(id)!;
  };
  const cancel=(id:string)=>{const job=jobs.get(id);if(job){job.child.kill('SIGTERM');jobs.delete(id);}const state=read(id);if(state){state.status='cancelled';state.message='扫码登录已取消';writeFileSync(join(root,id+'.json'),JSON.stringify(state));}return state;};
  const status=(id:string)=>read(id);
  const imagePath=(id:string)=>{const state=read(id);return state?join(root,state.image):null;};
  return {start,status,cancel,imagePath,store};
}
