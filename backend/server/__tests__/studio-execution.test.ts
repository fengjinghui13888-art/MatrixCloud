import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStudio} from '../studio';
import {recoverStalledExecutions} from '../studio-execution';
import {expect,it} from 'vitest';
it('expires an abandoned execution while preserving content and recent tasks',async()=>{
 const studio=createStudio(join(mkdtempSync(join(tmpdir(),'studio-timeout-')),'studio.sqlite'));
 const make=(requestId:string)=>studio.create({accountId:'a',topic:'t',persona:'p',style:'s',imageCount:1,size:'1024x1536',confirmCharge:true,requestId}).task;
 let stale=make('stale-task');
 stale=studio.update(stale.id,stale.revision,{status:'filling',title:'保留标题',body:'保留正文'});
 const fresh=make('fresh-task');
 await recoverStalledExecutions(studio,Date.now()+16*60*1000);
 expect(studio.get(stale.id)).toMatchObject({status:'blocked',title:'保留标题',body:'保留正文'});
 expect(studio.get(stale.id).message).toContain('待核对');
 expect(studio.get(fresh.id).status).toBe('generating');
});
