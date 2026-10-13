import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import request from 'supertest';import {createGreyApp} from '../grey-app';import {createStore} from '../store';

test('archived media is authenticated, account-scoped and supports video byte ranges',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'xhs-media-'));const store=createStore(join(dir,'operations.sqlite'));const token='local-media-test-token-with-32-characters';
 const account={id:'a',name:'A',handle:'a',profile:'local:a',avatar:'',state:'connected' as const,followers:0,lastSyncedAt:new Date().toISOString()};
 const relative='a/2025-01-01/video/n/abc.mp4';mkdirSync(join(dir,'media','a/2025-01-01/video/n'),{recursive:true});writeFileSync(join(dir,'media',relative),'0123456789');
 store.importSnapshot({account,notes:[{id:'n',accountId:'a',title:'video',summary:'body',cover:null,url:null,publishedAt:'',metrics:{likes:null,comments:null,collects:null,shares:null},mediaAssets:[{id:'abc',kind:'video',index:0,sourceUrl:'https://sns.xhscdn.com/v.mp4',path:relative,bytes:10,sha256:'a'.repeat(64)}]} as any],comments:[]});
 const app=createGreyApp(store,token,{modelDataDir:dir});const url='/api/accounts/a/media/n/abc';
 expect((await request(app).get(url)).status).toBe(401);
 const r=await request(app).get(url).set('Authorization','Bearer '+token).set('Range','bytes=2-5');
 expect(r.status).toBe(206);expect(r.headers['content-range']).toBe('bytes 2-5/10');
 expect((await request(app).get('/api/accounts/b/media/n/abc').set('Authorization','Bearer '+token)).status).toBe(404);
 // A malformed stored path can never expose files outside the archive.
 store.listNotes()[0].mediaAssets![0].path='../operations.sqlite';
 expect((await request(app).get(url).set('Authorization','Bearer '+token)).status).toBe(404);
});
