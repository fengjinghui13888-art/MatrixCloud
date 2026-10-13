// @vitest-environment node
import {it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {openWorkbench} from '../../../local-connector/workbench-launch.mjs';

it.each([['darwin','open'],['win32','rundll32']])('opens the workbench with OS arguments on %s', (platform,command)=>{
 const child=new EventEmitter(),spawnFn=vi.fn(()=>child);
 openWorkbench('https://cloud.test/',{platform,spawnFn});
 expect(spawnFn).toHaveBeenCalledWith(command,platform==='win32'?['url.dll,FileProtocolHandler','https://cloud.test/']:['https://cloud.test/'],{stdio:'ignore',shell:false});
});
it('preserves the one-use authorization fragment and rejects executable URLs',()=>{
 const spawnFn=vi.fn(()=>new EventEmitter()),url='https://cloud.test/#connectorSetup='+'a'.repeat(64);
 openWorkbench(url,{platform:'darwin',spawnFn});expect(spawnFn.mock.calls[0][1]).toEqual([url]);
 expect(()=>openWorkbench('file:///tmp/start.sh',{spawnFn})).toThrow();
 expect(()=>openWorkbench('https://cloud.test/other',{spawnFn})).toThrow();
 expect(spawnFn).toHaveBeenCalledTimes(1);
});
