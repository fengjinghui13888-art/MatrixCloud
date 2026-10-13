// @vitest-environment node
import {EventEmitter} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {it,expect,vi} from 'vitest';
const calls=vi.hoisted(()=>[] as {bin:string;args:string[];input?:string}[]);
vi.mock('node:child_process',()=>({spawn:(bin:string,args:string[])=>{
 const call={bin,args,input:undefined as string|undefined};calls.push(call);
 const child:any=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=vi.fn();
 child.stdin={end:(input:string)=>{call.input=input;queueMicrotask(()=>{if(args[0]==='image')child.stdout.emit('data','sha256:'+'b'.repeat(64));child.emit('exit',0,null);});}};
 return child;
}}));
import {maintenanceRunner} from '../maintenance-runner';
it('builds from the exact local dependency image without treating its ID as a registry repository',async()=>{
 const root=mkdtempSync(join(tmpdir(),'maintenance-runner-'));
 try{
  writeFileSync(join(root,'helper.py'),'');writeFileSync(join(root,'pnpm-lock.yaml'),'lock');
  const image='sha256:'+'a'.repeat(64);
  const run=maintenanceRunner({checksImage:image,lockHash:createHash('sha256').update('lock').digest('hex'),deployHelper:join(root,'helper.py'),backupRoot:root,postgres:true,container:'matrix-cloud'});
  const result=await run('build',{directory:root,commit:'c'.repeat(40)});
  expect(result.ok).toBe(true);
  const tag=calls.find(c=>c.args[0]==='tag')!;expect(tag.args[1]).toBe(image);
  const build=calls.find(c=>c.args[0]==='build')!;
  expect(build.input?.split('\n')[0]).toBe('FROM '+tag.args[2]);
  expect(build.input).not.toContain('FROM sha256:');expect(build.args).toContain('--network=none');
  await run('checks',{directory:root,commit:'c'.repeat(40)});
  const checks=calls.find(c=>c.args[0]==='run')!;
  expect(checks.args).toContain('--env=NODE_ENV=test');
 }finally{rmSync(root,{recursive:true,force:true});calls.length=0;}
});
