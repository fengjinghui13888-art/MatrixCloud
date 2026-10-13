import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../store';
import {createLocalAccounts} from '../local-accounts';
const verified={creatorLoggedIn:true,webLoggedIn:true,handle:'1111',webHandle:'1111',name:'A'};
function setup(state:()=>Promise<any>){const dir=mkdtempSync(join(tmpdir(),'adversarial-login-'));const store=createStore(join(dir,'ops.sqlite'));const connector:any={login:vi.fn(async()=>({})),state:vi.fn(state),image:vi.fn(async()=>({data:'image'}))};return {dir,store,connector,manager:createLocalAccounts(dir,store,connector)};}
test('cancel wins over an in-flight successful identity response',async()=>{
 let resolve!:(v:any)=>void;const x=setup(()=>new Promise(r=>resolve=r));const job=await x.manager.start();const pending=x.manager.status(job.id);
 x.manager.cancel(job.id);resolve(verified);
 expect((await pending).status).toBe('cancelled');expect(x.store.listAccounts()).toHaveLength(0);
});
test('concurrent polls write a verified binding only once',async()=>{
 let resolve!:(v:any)=>void;const state=new Promise(r=>resolve=r);const x=setup(()=>state);const job=await x.manager.start();const save=vi.spyOn(x.store,'importSnapshot');
 const pending=Promise.all([x.manager.status(job.id),x.manager.status(job.id)]);resolve(verified);await pending;
 expect(save).toHaveBeenCalledTimes(1);
});
test('web stage survives page reload and terminal jobs cannot serve QR',async()=>{
 const x=setup(async()=>({...verified,webLoggedIn:false}));const job=await x.manager.start();await x.manager.status(job.id);
 expect(x.manager.latest()?.stage).toBe('web');x.manager.cancel(job.id);
 await expect(x.manager.image(job.id)).rejects.toThrow();expect(x.connector.image).not.toHaveBeenCalled();
});
test('missing web identity cannot bind even if boolean claims logged in',async()=>{
 const x=setup(async()=>({...verified,webHandle:''}));const job=await x.manager.start();
 expect((await x.manager.status(job.id)).status).not.toBe('authenticated');expect(x.store.listAccounts()).toHaveLength(0);
});
test('repeated starts reuse pending login instead of spawning profiles',async()=>{
 const x=setup(async()=>verified);const [a,b]=await Promise.all([x.manager.start(),x.manager.start()]);
 expect(a.id).toBe(b.id);expect(x.connector.login).toHaveBeenCalledTimes(1);
});
test('expired QR tasks stop before contacting connector',async()=>{
 const x=setup(async()=>verified);const job=await x.manager.start();const file=join(x.dir,'local-logins',job.id+'.json');
 writeFileSync(file,JSON.stringify({...JSON.parse(readFileSync(file,'utf8')),createdAt:'2020-01-01T00:00:00.000Z'}));
 expect((await x.manager.status(job.id)).status).toBe('failed');expect(x.connector.state).not.toHaveBeenCalled();
});
test('deleting a target during verification does not resurrect it',async()=>{
 let resolve!:(v:any)=>void;const x=setup(()=>new Promise(r=>resolve=r));x.store.addAccount({id:'a',handle:'1111',name:'A',profile:'local:existing',avatar:'',followers:0,lastSyncedAt:'',state:'connected'});
 const job=await x.manager.start('a');const pending=x.manager.status(job.id);x.store.deleteAccount('a');resolve(verified);
 expect((await pending).status).toBe('cancelled');expect(x.store.listAccounts()).toHaveLength(0);
});
