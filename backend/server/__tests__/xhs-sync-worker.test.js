// @vitest-environment node
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.resetModules();vi.doUnmock('../../../scripts/xhs-playwright.mjs');});

test('the worker reports preparation and retries a terminal receipt after its first progress request fails',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'sync-worker-progress-')),id='77777777-7777-7777-7777-777777777777',statePath=join(dir,id+'.json');
 const target={id:'fixture',handle:'fixture',profile:'local:fixture',name:'fixture'};
 const initial={id,accountId:target.id,profile:target.profile,status:'running',stage:'starting',message:'starting',counts:{notes:0,comments:0,messages:0},startedAt:new Date().toISOString()};
 writeFileSync(statePath,JSON.stringify(initial));
 for(const [key,value] of Object.entries({SYNC_STATE_PATH:statePath,SYNC_ACCOUNT_ID:target.id,SYNC_PROFILE:target.profile,SYNC_DURABLE:'1',SYNC_API_BASE:'http://fixture.invalid',STUDIO_TOKEN:'fixture',SYNC_DATA_DIR:dir,DATA_DIR:dir,LOCAL_CONNECTOR_URL:''}))vi.stubEnv(key,value);
 const calls=[];let progressAttempts=0;
 vi.stubGlobal('fetch',async(url,options={})=>{
  const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):undefined;calls.push({path,body});
  if(path.endsWith('/progress')){
   if(++progressAttempts===1)return new Response(JSON.stringify({message:'fixture progress unavailable'}),{status:503});
   return new Response(JSON.stringify({...initial,...body}));
  }
  if(path==='/api/accounts')return new Response(JSON.stringify([target]));
  if(path.includes('/notes'))return new Response(JSON.stringify({items:[],hasNext:false}));
  throw Error('unexpected fixture request '+path);
 });
 vi.doMock('../../../scripts/xhs-playwright.mjs',()=>({collectWithPlaywright:async({onProgress})=>{await onProgress({stage:'notes',message:'fixture notes'});throw Error('unexpected collection');}}));
 const argv=process.argv,exitCode=process.exitCode;process.argv=[argv[0],argv[1],id];
 try{
  await expect(import('../../../scripts/xhs-sync.mjs')).resolves.toBeDefined();
  expect(calls[0]).toMatchObject({path:'/api/sync-jobs/'+id+'/progress',body:{stage:'account'}});
  expect(calls).toHaveLength(2);
  expect(calls[1].body).toMatchObject({status:'blocked',error:'fixture progress unavailable'});
  expect(JSON.parse(readFileSync(statePath,'utf8'))).toMatchObject({status:'blocked',error:'fixture progress unavailable'});
 }finally{process.argv=argv;process.exitCode=exitCode;rmSync(dir,{recursive:true,force:true});}
});
