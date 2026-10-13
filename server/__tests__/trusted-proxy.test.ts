// @vitest-environment node
import express from 'express';
import request from 'supertest';
import {afterEach,it,expect,vi} from 'vitest';
import {configureTrustedProxy,forwardedSecure} from '../trusted-proxy';
afterEach(()=>vi.unstubAllEnvs());
it('requires explicit loopback ingress trust and preserves the external client identity',async()=>{
 const make=()=>{const app=express();configureTrustedProxy(app);app.get('/',(req,res)=>res.json({secure:req.secure,ip:req.ip,websocketSecure:forwardedSecure(req)}));return app;};
 vi.stubEnv('TRUST_LOOPBACK_PROXY','0');
 const direct=await request(make()).get('/').set('X-Forwarded-Proto','https').set('X-Forwarded-For','198.51.100.7');
 expect(direct.body.secure).toBe(false);expect(direct.body.websocketSecure).toBe(false);expect(direct.body.ip).not.toBe('198.51.100.7');
 vi.stubEnv('TRUST_LOOPBACK_PROXY','1');
 const proxied=await request(make()).get('/').set('X-Forwarded-Proto','https').set('X-Forwarded-For','198.51.100.7');
 expect(proxied.body).toEqual({secure:true,ip:'198.51.100.7',websocketSecure:true});
 expect(forwardedSecure({socket:{remoteAddress:'198.51.100.8'},headers:{'x-forwarded-proto':'https'}} as any)).toBe(false);
});
