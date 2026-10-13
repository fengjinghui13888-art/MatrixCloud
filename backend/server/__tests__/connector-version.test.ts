// @vitest-environment node
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {it,expect,vi,afterEach} from 'vitest';
import {createLocalConnector} from '../local-connector';
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
it.each([4])('existing account connection accepts supported device version %s',async version=>{
 const dir=mkdtempSync(join(tmpdir(),'connector-version-'));
 vi.stubEnv('LOCAL_CONNECTOR_URL','http://127.0.0.1:47822');
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({ok:true,version,capabilities:['device-queue','stop-ack','passive-state','paced-actions']}))));
 try{const c=createLocalConnector(dir);expect(await c.status()).toMatchObject({ok:true,version});expect(await c.ensure()).toMatchObject({ok:true,version});}finally{rmSync(dir,{recursive:true,force:true});}
});
it('rejects unknown device versions without launching a competing connector',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'connector-version-'));
 vi.stubEnv('LOCAL_CONNECTOR_URL','http://127.0.0.1:47822');
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({ok:true,version:999}))));
 try{await expect(createLocalConnector(dir).ensure()).rejects.toThrow('执行设备状态无效');}finally{rmSync(dir,{recursive:true,force:true});}
});

it.each([2,3])('requires upgrade for legacy device %s',async version=>{const dir=mkdtempSync(join(tmpdir(),'old-connector-'));vi.stubEnv('LOCAL_CONNECTOR_URL','http://127.0.0.1:47822');vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({ok:true,version}))));try{await expect(createLocalConnector(dir).ensure()).rejects.toThrow();}finally{rmSync(dir,{recursive:true,force:true});}});
