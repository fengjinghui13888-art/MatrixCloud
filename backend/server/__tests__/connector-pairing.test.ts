// @vitest-environment node
import {createServer} from 'node:http';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalConnector} from '../local-connector';
test('healthy device with wrong pairing token must not be reported connected',async()=>{
 const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');if(req.url==='/health')res.end(JSON.stringify({ok:true,version:2}));else res.writeHead(401).end(JSON.stringify({message:'未授权'}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 vi.stubEnv('LOCAL_CONNECTOR_URL','http://127.0.0.1:'+(server.address() as any).port);
 try{const c=createLocalConnector(mkdtempSync(join(tmpdir(),'pairing-audit-')));expect(await c.status()).toMatchObject({ok:false});await expect(c.ensure()).rejects.toThrow('配对');}
 finally{vi.unstubAllEnvs();await new Promise<void>(r=>server.close(()=>r()));}
});
