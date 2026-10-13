import {mkdtempSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import request from 'supertest';
import {createGreyApp} from '../grey-app';import {createStore} from '../store';
import {executionToken,executionWorkspace,withExecutionAccess} from '../execution-access';
test('local connector routes cannot be accessed anonymously or across workspaces',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'connector-auth-'));const token='test-service-credential-longer-than-32';const app=createGreyApp(createStore(join(dir,'ops.sqlite')),token,{modelDataDir:dir});
 for(const path of ['/api/local-connector/status','/api/xhs/qr-login','/api/xhs/qr-login/11111111-1111-1111-1111-111111111111/image'])expect((await request(app).get(path)).status).toBe(401);
 expect((await request(app).post('/api/xhs/qr-login').send({})).status).toBe(401);
 let taskToken:string|undefined;withExecutionAccess('11111111-1111-1111-1111-111111111111',()=>{taskToken=executionToken();});expect(executionWorkspace(taskToken!)).toBe('11111111-1111-1111-1111-111111111111');expect(executionWorkspace('wrong')).toBeNull();
});
