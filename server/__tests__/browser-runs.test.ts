// @vitest-environment node
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {BrowserRuns} from '../browser-runs';
test('lease release notifies only after a real deletion and keeps release void',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'lease-events-'));try{
  const runs=new BrowserRuns(join(dir,'runs.sqlite')),seen:any[]=[];const off=runs.onRelease((lease:any)=>{expect(runs.active('h')).toBeNull();seen.push(lease);});
  runs.claim('h','studio','local:p');expect(seen).toEqual([]);expect(runs.release('studio')).toBeUndefined();await Promise.resolve();expect(seen).toEqual([{id:'studio',profile:'local:p'}]);
  runs.release('studio');runs.claim('h','deleted','local:p');runs.releaseAccount('h');await Promise.resolve();expect(seen).toHaveLength(1);off();runs.claim('h','last','local:p');runs.release('last');expect(seen).toHaveLength(1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
