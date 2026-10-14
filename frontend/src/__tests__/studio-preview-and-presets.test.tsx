import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {OneClickPublish} from '../OneClickPublish';
import {personaPresets,stylePresets} from '../creation-presets';

test('generated image opens in a large preview and can close',async()=>{
 const task={id:'qa-preview',revision:1,accountId:'a',status:'review',topic:'test',title:'Preview',body:'body',tags:[],images:['/image.png'],imageCount:1,message:'ready'};
 render(<OneClickPublish accounts={[]} request={async path=>path==='studio'?[task]:null}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Preview'}));fireEvent.click(screen.getByRole('button',{name:'放大查看生成配图 1'}));
 expect(screen.getByRole('dialog',{name:'图片预览'})).toBeInTheDocument();expect(screen.getByAltText('放大配图 1')).toHaveAttribute('src','/image.png');
 fireEvent.click(screen.getByRole('button',{name:'关闭图片预览'}));expect(screen.queryByRole('dialog')).toBeNull();
});

test('specific persona and style instructions reach generation unchanged',async()=>{
 const request=vi.fn(async(path:string)=>path==='studio'?[]:{id:'qa',revision:1,status:'generating',title:'',body:'',tags:[],images:[],message:'working'});
 const account={id:'a',name:'A',handle:'a',profile:'local:a',avatar:'',state:'connected' as const,followers:0,lastSyncedAt:''};
 render(<OneClickPublish accounts={[account]} request={request}/>);
 fireEvent.change(screen.getByLabelText('选题'),{target:{value:'活动报名'}});fireEvent.change(screen.getByLabelText('人设模板'),{target:{value:personaPresets[0].value}});fireEvent.change(screen.getByLabelText('文案风格模板'),{target:{value:stylePresets[0].value}});
 fireEvent.click(screen.getByRole('button',{name:'生成图文'}));await waitFor(()=>expect(request).toHaveBeenCalledWith('studio/generate?async=1',expect.objectContaining({persona:personaPresets[0].value,style:stylePresets[0].value})));
});
