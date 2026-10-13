// @vitest-environment node
import {archiveMedia} from '../../../scripts/xhs-media.mjs';
test('already verified cloud media needs no browser access or download',async()=>{
 const notes=[{id:'n',images:['https://sns.xhscdn.com/a.jpg'],cover:null,mediaAssets:[{id:'a',kind:'image',index:0,sourceUrl:'https://sns.xhscdn.com/a.jpg'}]}];
 const result=await archiveMedia({notes,accountId:'owner',root:'/unused',availableAssets:['n:a'],context:{cookies:()=>{throw Error('must not read cookies for cached media');}}});
 expect(result.cached).toBe(1);expect(result.failed).toBe(0);expect(notes[0].mediaAssets[0].id).toBe('a');
});
