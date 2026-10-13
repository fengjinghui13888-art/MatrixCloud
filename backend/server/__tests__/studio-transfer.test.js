import {it,expect} from 'vitest';
import {createContext,runInContext} from 'node:vm';
import {TextDecoder} from 'node:util';
import {evaluateScript} from '../../../scripts/studio-transfer.mjs';
it('roundtrips a large unicode script with quotes and newlines without oversized arguments',async()=>{
 const value=('中文😀\\n\n\"\'').repeat(6000);
 const context=createContext({window:{},TextDecoder,atob});
 const result=await evaluateScript(async source=>{expect(Buffer.byteLength(source)).toBeLessThan(24000);return runInContext(source,context);},JSON.stringify(value));
 expect(result).toBe(value);expect(Object.keys(context.window)).toHaveLength(0);
});
it('rejects corrupted chunks before evaluating the assembled script',async()=>{
 const context=createContext({window:{},TextDecoder,atob});
 await expect(evaluateScript(async source=>{const result=runInContext(source,context);return typeof result==='number'?result-1:result;},JSON.stringify('x'.repeat(30000)))).rejects.toThrow('传输不完整');
 expect(Object.keys(context.window)).toHaveLength(0);
});
it('batches small chunks into bounded bridge requests without changing the assembled source',async()=>{
 const value=('中文😀\n\\').repeat(130000);
 const context=createContext({window:{},TextDecoder,atob});let calls=0;
 const result=await evaluateScript(async source=>{calls++;expect(Buffer.byteLength(source)).toBeLessThan(64000);return runInContext(source,context);},JSON.stringify(value),{batchSize:4});
 expect(result).toBe(value);expect(Object.keys(context.window)).toHaveLength(0);
 // The original per-chunk path takes hundreds of requests for this payload.
 expect(calls).toBeLessThan(60);
});
it('rejects a corrupt intermediate length inside a batch before executing any payload',async()=>{
 const context=createContext({window:{},TextDecoder,atob});
 await expect(evaluateScript(async source=>{const r=runInContext(source,context);if(Array.isArray(r))r[1]--;return r;},`window.executed=true;${JSON.stringify('x'.repeat(100000))}`,{batchSize:4})).rejects.toThrow('传输不完整');
 expect(context.window.executed).toBeUndefined();expect(Object.keys(context.window)).toHaveLength(0);
});
it('stops on a lost batched reply without executing the assembled script a second time',async()=>{
 const context=createContext({window:{},TextDecoder,atob});
 await expect(evaluateScript(async source=>{const r=runInContext(source,context);if(Array.isArray(r))throw Error('command_result_unknown');return r;},`window.executed=true;${JSON.stringify('x'.repeat(100000))}`,{batchSize:4})).rejects.toThrow('command_result_unknown');
 expect(context.window.executed).toBeUndefined();expect(Object.keys(context.window)).toHaveLength(0);
});
