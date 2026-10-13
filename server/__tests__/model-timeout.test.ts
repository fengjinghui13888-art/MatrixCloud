import { EventEmitter } from 'node:events';
import { vi, beforeEach, afterEach, test, expect } from 'vitest';
import { publicHttpsJson } from '../model-gateway';
const state=vi.hoisted(()=>({callback:null as any,req:null as any}));
vi.mock('node:dns/promises',()=>{const m={resolve4:async()=>['8.8.8.8']};return {...m,default:m};});
vi.mock('node:https',()=>{const m={request:(_options:any,callback:any)=>{
 state.callback=callback;const req:any=new EventEmitter();state.req=req;
 req.end=()=>{};req.destroy=(error:Error)=>{req.emit('error',error);req.emit('close');};return req;
}};return {...m,default:m};});
beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
test('text response after 30 seconds is accepted, actual 120 second deadline is explicit',async()=>{
 const pending=publicHttpsJson('https://provider.example/chat/completions',{},{});
 await vi.advanceTimersByTimeAsync(31000);expect(state.req).not.toBeNull();
 const res:any=new EventEmitter();res.statusCode=200;state.callback(res);
 res.emit('data',Buffer.from('{"ok":true}'));res.emit('end');state.req.emit('close');
 await expect(pending).resolves.toEqual({ok:true});
 const timed=publicHttpsJson('https://provider.example/chat/completions',{},{});
 const assertion=expect(timed).rejects.toMatchObject({code:'TIMEOUT',message:expect.stringContaining('120 秒')});
 await vi.advanceTimersByTimeAsync(120001);await assertion;
});
test('provider failures and oversized results are distinct and do not echo provider secrets',async()=>{
 const pending=publicHttpsJson('https://provider.example/images/edits',{},Buffer.from('image'));
 const assertion=expect(pending).rejects.toMatchObject({code:'HTTP',status:503});
 await vi.advanceTimersByTimeAsync(1);const res:any=new EventEmitter();res.statusCode=503;res.resume=()=>{};state.callback(res);state.req.emit('close');await assertion;
 const oversized=publicHttpsJson('https://provider.example/chat/completions',{},{});
 const sizeAssertion=expect(oversized).rejects.toMatchObject({code:'SIZE_LIMIT'});
 await vi.advanceTimersByTimeAsync(1);const large:any=new EventEmitter();large.statusCode=200;state.callback(large);large.emit('data',Buffer.alloc(1024*1024+1));await sizeAssertion;
});
