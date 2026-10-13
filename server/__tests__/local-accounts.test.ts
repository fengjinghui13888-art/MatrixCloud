import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createStore} from '../store';import {createLocalAccounts} from '../local-accounts';
test('scan of another account never overwrites target; verified scan migrates existing profile',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'local-binding-'));const store=createStore(join(dir,'ops.sqlite'));
 store.addAccount({id:'a',name:'A',handle:'1111',profile:'old',avatar:'',state:'connected',followers:7,lastSyncedAt:new Date().toISOString()});
 let handle='2222';const connector:any={login:async()=>({}),state:async()=>({creatorLoggedIn:true,webLoggedIn:true,handle,webHandle:handle,name:'A',followers:9})};
 const manager=createLocalAccounts(dir,store,connector);const job=await manager.start('a');
 expect((await manager.status(job.id)).status).toBe('failed');expect(store.listAccounts()[0].profile).toBe('old');
 handle='1111';const next=await manager.start('a');expect((await manager.status(next.id)).status).toBe('authenticated');
 expect(store.listAccounts()).toHaveLength(1);expect(store.listAccounts()[0].profile).toBe('local:'+next.sessionId);
 const other=createLocalAccounts(mkdtempSync(join(tmpdir(),'other-binding-')),store,connector);await expect(other.status(next.id)).rejects.toThrow('工作区');
});

test('web login is a required second stage before binding',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'local-web-stage-'));const store=createStore(join(dir,'ops.sqlite'));
 let info:any={creatorLoggedIn:true,webLoggedIn:false,stage:'web',handle:'1111',name:'A'};
 const connector:any={login:async()=>({}),state:async()=>info};
 const manager=createLocalAccounts(dir,store,connector);const job=await manager.start();
 expect((await manager.status(job.id)).message).toContain('已打开小红书网页版');
 expect(store.listAccounts()).toHaveLength(0);
 info={creatorLoggedIn:true,webLoggedIn:true,stage:'ready',handle:'1111',webHandle:'2222',name:'A'};
 expect((await manager.status(job.id)).status).toBe('failed');
 expect(store.listAccounts()).toHaveLength(0);
});

test('matching creator and web identities can be bound',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'local-web-match-'));const store=createStore(join(dir,'ops.sqlite'));
 const connector:any={login:async()=>({}),state:async()=>({creatorLoggedIn:true,webLoggedIn:true,stage:'ready',handle:'1111',webHandle:'1111',name:'A',followers:3})};
 const manager=createLocalAccounts(dir,store,connector);const job=await manager.start();
 const result=await manager.status(job.id);
 expect(result.status).toBe('authenticated');expect((result as any).accountWritten).toBe(true);expect(store.listAccounts()[0].handle).toBe('1111');
});

test('second account remains independent and authenticated polling is terminal',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'two-accounts-'));const store=createStore(join(dir,'ops.sqlite'));
 let handle='1111';const connector:any={login:async()=>({}),state:vi.fn(async()=>({creatorLoggedIn:true,webLoggedIn:true,handle,webHandle:handle,name:handle}))};
 const manager=createLocalAccounts(dir,store,connector);const first=await manager.start();await manager.status(first.id);
 handle='2222';const second=await manager.start();const result:any=await manager.status(second.id);
 expect(store.listAccounts()).toHaveLength(2);expect(first.sessionId).not.toBe(second.sessionId);
 expect(store.listAccounts().find(a=>a.handle==='1111')?.profile).toBe('local:'+first.sessionId);
 const calls=connector.state.mock.calls.length;handle='3333';await manager.status(second.id);
 expect(connector.state.mock.calls).toHaveLength(calls);
 expect(store.listAccounts()).toHaveLength(2);expect(result.account.handle).toBe('2222');
});

test('reconnecting an existing account starts a fresh session for the selected computer',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'move-computer-'));const store=createStore(join(dir,'ops.sqlite'));
 store.addAccount({id:'a',name:'A',handle:'1111',profile:'local:old-computer-session',avatar:'',state:'connected',followers:7,lastSyncedAt:''});
 const connector:any={login:vi.fn(async()=>({})),state:async()=>({creatorLoggedIn:true,webLoggedIn:true,handle:'1111',webHandle:'1111',name:'A'})};
 const manager=createLocalAccounts(dir,store,connector),job=await manager.start('a');
 expect(job.sessionId).not.toBe('old-computer-session');
 expect(connector.login).toHaveBeenCalledWith(job.sessionId,undefined);
 expect(store.listAccounts()[0].profile).toBe('local:old-computer-session');
 await manager.status(job.id);
 expect(store.listAccounts()[0].profile).toBe('local:'+job.sessionId);
});

test('moving an unfinished login to another computer cancels the old attempt and ignores its late status',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'move-pending-login-')),store=createStore(join(dir,'ops.sqlite'));
 store.addAccount({id:'a',name:'A',handle:'1111',profile:'local:original',avatar:'',state:'connected',followers:7,lastSyncedAt:''});
 const connector:any={login:async()=>({}),state:async()=>({creatorLoggedIn:true,webLoggedIn:true,handle:'1111',webHandle:'1111',name:'A'})};
 const manager=createLocalAccounts(dir,store,connector);
 const mac=await manager.start('a','mac','Mac');const win=await manager.start('a','windows','Windows');
 expect(win.deviceId).toBe('windows');expect((await manager.status(mac.id)).status).toBe('cancelled');
 expect(store.listAccounts()[0].profile).toBe('local:original');
 await manager.status(win.id);expect(store.listAccounts()[0].profile).toBe('local:'+win.sessionId);
});

test('a deleted account can be added again with the same handle',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'readd-after-delete-')),store=createStore(join(dir,'ops.sqlite'));
 store.addAccount({id:'old-account',name:'旧账号',handle:'1111',profile:'local:old-session',avatar:'',state:'connected',followers:4,lastSyncedAt:''});
 const connector:any={login:vi.fn(async()=>({})),remove:vi.fn(async()=>true),state:async()=>({creatorLoggedIn:true,webLoggedIn:true,stage:'ready',handle:'1111',webHandle:'1111',name:'重新登录账号',followers:5})};
 const manager=createLocalAccounts(dir,store,connector);
 await manager.remove('old-account');
 expect(store.listAccounts()).toHaveLength(0);
 const login=await manager.start();
 const result:any=await manager.status(login.id);
 expect(result.status).toBe('authenticated');
 expect(result.account.id).toBe('xhs-1111');
 expect(store.listAccounts()[0]).toMatchObject({id:'xhs-1111',handle:'1111',profile:'local:'+login.sessionId});
});
