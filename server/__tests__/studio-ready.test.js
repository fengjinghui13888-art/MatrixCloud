import {it,expect,vi} from 'vitest';
import {waitForCreator,prepareImageCreator,imageTabTarget} from '../../scripts/prepare-studio-page.mjs';

it('waits through transient renderer errors with a bounded deadline',async()=>{
 let time=0;const options={now:()=>time,sleep:async ms=>{time+=ms;},interval:50,timeout:200};
 const read=vi.fn().mockRejectedValueOnce(Error('Runtime.evaluate 超时')).mockResolvedValueOnce({ready:false}).mockResolvedValueOnce({ready:true});
 expect(await waitForCreator(read,v=>v.ready,options)).toEqual({ready:true});
 expect(time).toBe(100);
 await expect(waitForCreator(async()=>{throw Error('页面无响应');},()=>false,options)).rejects.toThrow('页面无响应');
 expect(time).toBe(300);
});

it('switches an empty existing creator once without creating another tab',async()=>{
 const page={tabs:async()=>[{page:'video',url:'https://creator.xiaohongshu.com/publish/publish?target=video'}],selectTab:vi.fn(),nativeClick:vi.fn(),newTab:vi.fn()};
 const evaluate=vi.fn().mockResolvedValueOnce({ready:true}).mockResolvedValueOnce(true).mockResolvedValueOnce({x:433,y:101}).mockResolvedValueOnce({url:'https://creator.xiaohongshu.com/publish/publish?target=image'});
 expect(await prepareImageCreator({page,evaluate,foreground:vi.fn()})).toBe('video');
 expect(page.nativeClick).toHaveBeenCalledTimes(1);expect(page.nativeClick).toHaveBeenCalledWith(433,101);
 expect(page.newTab).not.toHaveBeenCalled();
});

it('preserves an occupied composer and opens one fresh image page instead',async()=>{
 const page={tabs:async()=>[{page:'video',url:'https://creator.xiaohongshu.com/publish/publish?target=video'}],selectTab:vi.fn(),nativeClick:vi.fn(),newTab:vi.fn().mockResolvedValue('fresh')};
 const evaluate=vi.fn().mockResolvedValue({ready:true,editor:true,title:'未保存内容'});
 expect(await prepareImageCreator({page,evaluate,foreground:vi.fn()})).toBe('fresh');
 expect(page.nativeClick).not.toHaveBeenCalled();expect(page.newTab).toHaveBeenCalledTimes(1);
 expect(evaluate.mock.calls.every(([code])=>!code.includes('.click()'))).toBe(true);
});

it('refuses to switch when a file, title, or editor already contains work',()=>{
 document.body.innerHTML='<div id="web"><input value="未保存标题"><div class="creator-tab">上传图文</div></div>';
 expect(imageTabTarget().reason).toContain('未保存内容');
 document.body.innerHTML='<div id="web"><input type="file"></div>';
 Object.defineProperty(document.querySelector('input'),'files',{value:[{name:'draft.mp4'}]});
 expect(imageTabTarget().reason).toContain('未保存内容');
});

it('selects an existing image page without switching or opening duplicates',async()=>{
 const page={tabs:async()=>[{page:'image',url:'https://creator.xiaohongshu.com/publish/publish?target=image'}],selectTab:vi.fn(),nativeClick:vi.fn(),newTab:vi.fn()};
 const evaluate=vi.fn().mockResolvedValue({ready:true});expect(await prepareImageCreator({page,evaluate,foreground:vi.fn()})).toBe('image');
 expect(evaluate).toHaveBeenCalledTimes(2);expect(page.nativeClick).not.toHaveBeenCalled();expect(page.newTab).not.toHaveBeenCalled();
});
