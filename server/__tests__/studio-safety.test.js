// @vitest-environment node
import {it,expect,vi} from 'vitest';
import {protectStudioConnection} from '../../scripts/studio-safety.mjs';
it('stops draft mutations on visible verification and HTTP throttling',async()=>{
 let listener;let text='正常创作页';const command=vi.fn(async()=>({}));const guard={check:vi.fn(),halt:vi.fn()};const connection={evaluate:vi.fn(async()=>text),page:{cdp:command,onEvent:async fn=>{listener=fn},selectTab:vi.fn(),nativeClick:vi.fn()}};
 await protectStudioConnection(connection,guard,vi.fn());
 listener({method:'Network.responseReceived',params:{response:{url:'https://creator.xiaohongshu.com/api/draft',status:429,headers:{'Retry-After':'60'}}}});
 await expect(connection.page.cdp('DOM.setFileInputFiles',{})).rejects.toThrow();expect(guard.halt).toHaveBeenCalledWith(expect.any(String),'60');expect(command).toHaveBeenCalledTimes(1);
 const other={evaluate:async()=> '请完成验证',page:{cdp:vi.fn(),selectTab:vi.fn()}};await protectStudioConnection(other,guard,vi.fn());await expect(other.evaluate('mutation()')).rejects.toThrow();
});
