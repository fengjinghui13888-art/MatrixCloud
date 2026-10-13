// @vitest-environment node
import {EventEmitter} from 'node:events';
import {existsSync} from 'node:fs';
test('network collector waits for the body, records parse errors and ignores unrelated hosts',async()=>{
 expect(existsSync('scripts/xhs-network.mjs')).toBe(true);
 const {captureNetwork}=await import('../../../scripts/xhs-network.mjs');
 const ctx=new EventEmitter();const records=[];const net=captureNetwork(ctx,record=>records.push(record));
 let finish;const body=new Promise(r=>finish=r);
 ctx.emit('response',{url:()=> 'https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=n',headers:()=>({'content-type':'application/json'}),status:()=>200,json:()=>body,request:()=>({postData:()=>null})});
 expect(records).toHaveLength(0);finish({data:{comments:[]}});await net.flush();expect(records).toHaveLength(1);
 ctx.emit('response',{url:()=> 'https://edith.xiaohongshu.com/api/sns/web/v2/comment/page',headers:()=>({'content-type':'application/json'}),status:()=>200,json:async()=>{throw Error('invalid body');},request:()=>({postData:()=>null})});
 await net.flush();expect(net.errors).toHaveLength(1);net.stop();
});
test('network collector accepts the current selfinfo identity endpoint',async()=>{
 const {captureNetwork}=await import('../../../scripts/xhs-network.mjs');
 const ctx=new EventEmitter();const records=[];const net=captureNetwork(ctx,record=>records.push(record));
 ctx.emit('response',{url:()=> 'https://www.xiaohongshu.com/api/sns/web/v1/user/selfinfo',headers:()=>({'content-type':'application/json'}),status:()=>200,json:async()=>({success:true,data:{user_id:'u1',red_id:'r1'}}),request:()=>({postData:()=>null})});
 await net.flush();expect(records).toHaveLength(1);expect(records[0].path).toBe('/api/sns/web/v1/user/selfinfo');net.stop();
});
