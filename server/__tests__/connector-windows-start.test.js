// @vitest-environment node
import {afterEach,describe,expect,it} from 'vitest';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {cp,mkdir,mkdtemp,readFile,rm,symlink,writeFile,access,open,link} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const run=promisify(execFile),project=resolve('.'),fixtures=[];
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const powershell='powershell.exe';
async function fixture(){
 const base=await mkdtemp(join(tmpdir(),'matrix-start-'));
 const root=join(base,'矩阵 connector project'),home=join(base,'用户 home');
 await mkdir(join(root,'scripts'),{recursive:true});await mkdir(home);
 await cp(join(project,'local-connector'),join(root,'local-connector'),{recursive:true});
 await cp(join(project,'shared'),join(root,'shared'),{recursive:true});
 for(const name of ['start-local-connector.ps1','execution-guard.mjs','action-pacing.mjs'])await cp(join(project,'scripts',name),join(root,'scripts',name));
 await symlink(join(project,'node_modules'),join(root,'node_modules'),'junction');
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const value={base,root,home,port};fixtures.push(value);return value;
}
async function launch(f,args=[],{node=process.execPath,env={}}={}){
 const suffix=String(f.launches=(f.launches||0)+1),outPath=join(f.base,'launcher-'+suffix+'.stdout'),errPath=join(f.base,'launcher-'+suffix+'.stderr');
 const out=await open(outPath,'w'),err=await open(errPath,'w');
 try{
  // Windows PowerShell 5.1 can inherit pipe handles into detached children.
  // Capture to local files so completion follows the launcher process itself.
  const child=spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(f.root,'scripts','start-local-connector.ps1'),...(node?['-Node',node]:[]),'-Port',String(f.port),...args],{cwd:f.home,env:{...process.env,USERPROFILE:f.home,HOME:f.home,MATRIX_CLOUD_URL:'',MATRIX_CLOUD_PAIRING_CODE:'',MATRIX_CLOUD_DEVICE_NAME:'',...env},stdio:['ignore',out.fd,err.fd]});
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('launcher timeout'));},30000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
  return {code,stdout:await readFile(outPath,'utf8'),stderr:await readFile(errPath,'utf8')};
 }finally{await out.close();await err.close();}
}
async function existingData(directory,token,{profile=false}={}){
 await mkdir(directory,{recursive:true});await writeFile(join(directory,'connector-token'),token);
 if(profile)await mkdir(join(directory,'previous-account','chrome-profile'),{recursive:true});
}
const health=f=>fetch(`http://127.0.0.1:${f.port}/health`,{signal:AbortSignal.timeout(1000)}).then(response=>response.json());
const tokenStatus=(f,token)=>fetch(`http://127.0.0.1:${f.port}/accounts/test/safety`,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(1000)}).then(response=>response.status);
async function owner(f){
 const {stdout}=await run(powershell,['-NoProfile','-NonInteractive','-Command',`(Get-NetTCPConnection -LocalPort ${f.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`]);return Number(stdout.trim());
}
afterEach(async()=>{
 for(const f of fixtures.splice(0)){
  // Only stop test processes whose command line names this isolated fixture.
  await run(powershell,['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine.Contains(${quote(join(f.root,'local-connector','connector.mjs'))}) } | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`]).catch(()=>{});
  await rm(f.base,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
});

describe.skipIf(process.platform!=='win32')('Windows connector startup',()=>{
 it('selects the first default Node when PATH contains multiple runtimes',async()=>{
  const f=await fixture(),data=join(f.base,'default runtime data');
  const firstRuntime=join(f.base,'first runtime'),secondRuntime=join(f.base,'second runtime');
  await mkdir(firstRuntime);await mkdir(secondRuntime);
  // Hard links add isolated PATH candidates without copying or changing Node.
  await link(process.execPath,join(firstRuntime,'node.exe'));await link(process.execPath,join(secondRuntime,'node.exe'));
  const pathKey=Object.keys(process.env).find(key=>key.toLowerCase()==='path')||'Path';
  const result=await launch(f,['-DataDir',data],{node:null,env:{[pathKey]:firstRuntime+';'+secondRuntime+';'+(process.env[pathKey]||'')}});
  expect(result.code,result.stderr).toBe(0);
  expect(await health(f)).toMatchObject({ok:true,connector:'matrix-cloud-local',version:4});
  const pid=await owner(f);
  const {stdout}=await run(powershell,['-NoProfile','-NonInteractive','-Command',`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ExecutablePath`]);
  expect(stdout.trim().toLowerCase()).toBe(join(firstRuntime,'node.exe').toLowerCase());
 },45000);
 it('starts the real connector with explicit data outside the project and waits for health',async()=>{
  const f=await fixture(),data=join(f.base,'明确 data directory');
  const result=await launch(f,['-DataDir',data]);
  expect(result.code,result.stderr).toBe(0);
  expect(await health(f)).toMatchObject({ok:true,connector:'matrix-cloud-local',version:4});
  expect(await readFile(join(data,'connector-token'),'utf8')).toMatch(/^[a-f0-9]{64}$/);
  await expect(access(join(f.root,'work','grey','local-connector'))).rejects.toThrow();
 },45000);
 it('prefers existing user browser data and preserves its token',async()=>{
  const f=await fixture(),data=join(f.home,'.matrix-cloud'),legacy=join(f.root,'work','grey','local-connector');
  await existingData(data,'a'.repeat(64),{profile:true});await existingData(legacy,'b'.repeat(64));
  const result=await launch(f);expect(result.code,result.stderr).toBe(0);
  expect(await tokenStatus(f,'a'.repeat(64))).toBe(200);
  expect(await tokenStatus(f,'b'.repeat(64))).toBe(401);
  expect(await readFile(join(data,'connector-token'),'utf8')).toBe('a'.repeat(64));
 },45000);
 it('preserves an existing project deployment when no user data exists',async()=>{
  const f=await fixture(),legacy=join(f.root,'work','grey','local-connector');
  await existingData(legacy,'b'.repeat(64));
  const result=await launch(f);expect(result.code,result.stderr).toBe(0);
  expect(await tokenStatus(f,'b'.repeat(64))).toBe(200);
  await expect(access(join(f.home,'.matrix-cloud','connector-token'))).rejects.toThrow();
 },45000);
 it('reuses a compatible instance with the same directory',async()=>{
  const f=await fixture(),data=join(f.base,'explicit data');
  const first=await launch(f,['-DataDir',data]);expect(first.code,first.stderr).toBe(0);
  const pid=await owner(f),second=await launch(f,['-DataDir',data]);
  expect(second.code,second.stderr).toBe(0);expect(second.stdout).toContain('已在运行');
  expect(await owner(f)).toBe(pid);expect(await health(f)).toMatchObject({ok:true});
 },45000);
 it('refuses to reuse a connector serving another directory',async()=>{
  const f=await fixture(),data=join(f.base,'first data'),other=join(f.base,'other data');
  const first=await launch(f,['-DataDir',data]);expect(first.code,first.stderr).toBe(0);
  const pid=await owner(f),second=await launch(f,['-DataDir',other]);
  expect(second.code).not.toBe(0);expect(await owner(f)).toBe(pid);
  expect(await health(f)).toMatchObject({ok:true});await expect(access(other)).rejects.toThrow();
 },45000);
 it('leaves another port owner running even when it advertises compatible health',async()=>{
  const f=await fixture(),data=join(f.base,'new data');
  const server=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,connector:'matrix-cloud-local',version:4,capabilities:['reconnect']}));});
  await new Promise(resolve=>server.listen(f.port,'127.0.0.1',resolve));
  try{const result=await launch(f,['-DataDir',data]);expect(result.code).not.toBe(0);expect(server.listening).toBe(true);expect(await health(f)).toMatchObject({ok:true});await expect(access(data)).rejects.toThrow();}
  finally{await new Promise(resolve=>server.close(resolve));}
 },45000);
 it('reports a failed process instead of claiming startup succeeded',async()=>{
  const f=await fixture();await rm(join(f.root,'shared','connector-protocol.mjs'));
  const result=await launch(f,['-DataDir',join(f.base,'failed data')]);
  expect(result.code).not.toBe(0);expect(result.stdout).not.toContain('已启动');
  await expect(health(f)).rejects.toThrow();
 },45000);
});
