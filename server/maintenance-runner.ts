import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import type {MaintenanceRunner} from './maintenance-service';
/** Commands are fixed here, never accepted from MCP arguments or modified source. */
export function maintenanceRunner(config:{checksImage:string;lockHash:string;deployHelper:string;backupRoot:string;postgres:boolean;container:string}):MaintenanceRunner{
 if(!/^sha256:[a-f0-9]{64}$/.test(config.checksImage)||!/^\w[\w.-]{0,80}$/.test(config.container))throw Error('维护运行环境配置无效');
 const helper=realpathSync(config.deployHelper),backups=realpathSync(config.backupRoot);
 async function command(bin:string,args:string[],cwd?:string,input?:string){return new Promise<{ok:boolean;summary:string}>((resolve,reject)=>{let output='';const child=spawn(bin,args,{cwd,env:{PATH:process.env.PATH,HOME:'/tmp',DOCKER_CONFIG:'/nonexistent'},stdio:['pipe','pipe','pipe']});const timer=setTimeout(()=>{child.kill('SIGTERM');},20*60*1000);child.stdout.on('data',c=>{output=(output+c.toString()).slice(-16000);});child.stderr.on('data',c=>{output=(output+c.toString()).slice(-16000);});child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',(code,signal)=>{clearTimeout(timer);if(signal){reject(Error('作业被中断，执行结果待核对'));return;}resolve({ok:code===0,summary:output.replace(/(?:Bearer\s+|api[_-]?key[=:]\s*)\S+/gi,'[凭证省略]')});});child.stdin.end(input);});}
 return async(kind,ctx)=>{
  if(!/^[a-f0-9]{40}$/.test(ctx.commit))throw Error('提交无效');
  if(kind==='checks'||kind==='build'){
   if(createHash('sha256').update(readFileSync(join(ctx.directory,'pnpm-lock.yaml'))).digest('hex')!==config.lockHash)throw Error('依赖锁文件变化，需要管理员重建并登记隔离检查镜像');
   if(kind==='checks')return command('docker',['run','--rm','--env=NODE_ENV=test','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=256','--memory=2g','--cpus=2','--tmpfs=/tmp:rw,size=512m,mode=1777','--mount',`type=bind,source=${realpathSync(ctx.directory)},target=/input,readonly`,'--entrypoint=/bin/sh',config.checksImage,'-c','mkdir /tmp/check && cp -R /input/. /tmp/check/ && ln -s /app/node_modules /tmp/check/node_modules && cd /tmp/check && node /app/node_modules/typescript/bin/tsc -b && node /app/node_modules/vitest/vitest.mjs run --maxWorkers=2 --minWorkers=1 --no-cache && node /app/node_modules/vite/bin/vite.js build']);
   const tag='matrix-maintenance:'+ctx.commit;
   // BuildKit treats a bare image ID in FROM as a registry name. Tag the exact
   // local ID first; docker tag never pulls a replacement from a registry.
   const base='matrix-maintenance-base:'+config.checksImage.slice(7);
   const tagged=await command('docker',['tag',config.checksImage,base]);if(!tagged.ok)return tagged;
   const result=await command('docker',['build','--network=none','--label','matrix.managed=true','--label','matrix.commit='+ctx.commit,'-t',tag,'-f','-',ctx.directory],undefined,`FROM ${base}\nUSER root\nWORKDIR /app\nCOPY . .\nRUN node node_modules/typescript/bin/tsc -b && node node_modules/vite/bin/vite.js build\nENV NODE_ENV=production PORT=4174 DATA_DIR=/app/work/grey HOST=0.0.0.0\nCMD ["node","--import","tsx","server/grey.ts"]\n`);
   if(!result.ok)return result;const inspect=await command('docker',['image','inspect','--format={{.Id}}',tag]);return {...result,imageDigest:inspect.summary.trim()};
  }
  if(!/^sha256:[a-f0-9]{64}$/.test(ctx.imageDigest??'')||!ctx.releaseId?.match(/^[a-f0-9-]{36}$/))throw Error('发布镜像或编号无效');
  return command('python3',[helper,'--name',config.container,'--image',ctx.imageDigest!,'--backup',join(backups,ctx.releaseId),...(config.postgres?['--postgres']:[])]);
 };
}
