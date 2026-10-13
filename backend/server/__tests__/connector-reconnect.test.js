import {describe,it,expect,vi} from 'vitest';
import {forwardToExisting} from '../../../local-connector/reconnect.mjs';
import {existingConnectorMessage,inspectExistingConnector} from '../../../local-connector/startup-guard.mjs';

describe('connector duplicate launch handoff',()=>{
 it('forwards pairing and browser intent to the existing connector',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true,message:'配对已转交'}),{status:200,headers:{'content-type':'application/json'}}));
  const result=await forwardToExisting({port:47821,token:'t'.repeat(64),pairingCode:'12345678',cloudUrl:'https://cloud.test/',deviceName:'测试电脑',onboard:true,fetcher});
  expect(result).toEqual({ok:true,message:'配对已转交'});
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url,options]=fetcher.mock.calls[0];
  expect(url).toBe('http://127.0.0.1:47821/reconnect');
  expect(options.method).toBe('POST');
  expect(options.headers.Authorization).toBe(`Bearer ${'t'.repeat(64)}`);
  expect(JSON.parse(options.body)).toEqual({pairingCode:'12345678',cloudUrl:'https://cloud.test/',deviceName:'测试电脑',onboard:true});
 });

 it('returns the existing connector rejection to the launcher',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({message:'配对码已过期'}),{status:400,headers:{'content-type':'application/json'}}));
  await expect(forwardToExisting({token:'t'.repeat(64),pairingCode:'12345678',fetcher})).rejects.toThrow('配对码已过期');
 });
});

describe('connector startup guard',()=>{
 it('detects a running connector without reconnect capability',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true,version:4,capabilities:['account-sync']}),{status:200}));
  const status=await inspectExistingConnector({port:47821,fetcher});
  expect(status.kind).toBe('connected');
  expect(existingConnectorMessage(status)).toContain('旧版连接器');
 });

 it('allows handoff only when the existing connector advertises reconnect',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({ok:true,version:4,capabilities:['reconnect']}),{status:200}));
  const status=await inspectExistingConnector({fetcher});
  expect(existingConnectorMessage(status)).toContain('转交');
 });
});
