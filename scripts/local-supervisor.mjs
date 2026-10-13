import {spawn} from 'node:child_process';
import {openSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=process.env.MATRIX_CLOUD_ROOT||fileURLToPath(new URL('..',import.meta.url)),logDir=join(root,'work','service-logs');mkdirSync(logDir,{recursive:true});writeFileSync(join(logDir,'supervisor.pid'),String(process.pid));
let child,stopping=false;
function start(){const nodeBin=dirname(process.execPath),pathValue=[nodeBin,process.env.PATH].filter(Boolean).join(process.platform==='win32'?';':':');child=spawn(process.execPath,['--import','tsx','server/grey.ts'],{cwd:root,stdio:['ignore',openSync(join(logDir,'workbench.log'),'a'),openSync(join(logDir,'workbench-error.log'),'a')],env:{...process.env,MATRIX_CLOUD_ROOT:root,PATH:pathValue}});child.on('exit',()=>{if(!stopping)setTimeout(start,2000);});}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;child?.kill('SIGTERM');process.exit(0);});
start();
