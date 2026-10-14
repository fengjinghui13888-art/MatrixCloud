import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {ModelSettings} from '../ModelSettings';
test('relay model discovery selects an authorized model and tests an unsaved text configuration',async()=>{
 const request=vi.fn(async(path:string,body?:any)=>path==='models/discover'?{models:['gpt-6.1-sol']}:path==='models'&&body?{...body,hasKey:true}:path==='models/chat'?{text:'连接成功'}:path==='models/profiles'?{profiles:[],activeId:''}:null);
 render(<ModelSettings request={request}/>);
 fireEvent.change(screen.getByLabelText('服务地址'),{target:{value:'https://apinebula.ai/v1'}});
 fireEvent.change(screen.getByLabelText('API 密钥'),{target:{value:'synthetic-key'}});
 fireEvent.click(screen.getByRole('button',{name:'获取文案模型列表'}));
 await waitFor(()=>expect(screen.getByLabelText('文案模型')).toHaveValue('gpt-6.1-sol'));
 fireEvent.click(screen.getByRole('checkbox'));
 const test=screen.getByRole('button',{name:'发起真实连接测试'});expect(test).toBeEnabled();fireEvent.click(test);
 await waitFor(()=>expect(request).toHaveBeenCalledWith('models',expect.objectContaining({model:'gpt-6.1-sol',apiKey:'synthetic-key',baseUrl:'https://apinebula.ai/v1'})));
 await waitFor(()=>expect(request).toHaveBeenCalledWith('models/chat',{prompt:'请简短回复：连接成功。',confirmCharge:true}));
});

test('pasted addresses and keys automatically fetch text and image models',async()=>{
 const request=vi.fn(async(path:string,body?:any)=>path==='models/discover'?{models:[body.kind==='text'?'text-authorized':'image-authorized']}:path==='models/profiles'?{profiles:[],activeId:''}:null);
 render(<ModelSettings request={request}/>);
 fireEvent.change(screen.getByLabelText('服务地址'),{target:{value:'https://relay.example/v1'}});fireEvent.change(screen.getByLabelText('API 密钥'),{target:{value:'text-synthetic'}});
 fireEvent.change(screen.getByLabelText('生图 API 地址'),{target:{value:'https://images.example/v1'}});fireEvent.change(screen.getByLabelText('生图 API 密钥'),{target:{value:'image-synthetic'}});
 await waitFor(()=>expect(screen.getByLabelText('文案模型')).toHaveValue('text-authorized'),{timeout:2500});
 await waitFor(()=>expect(screen.getByLabelText('生图模型')).toHaveValue('image-authorized'));
 expect(request).toHaveBeenCalledWith('models/discover',expect.objectContaining({kind:'image',baseUrl:'https://images.example/v1',apiKey:'image-synthetic'}));
 expect(request.mock.calls.some(([path])=>path==='models/chat'||path==='models/images')).toBe(false);
});

test('configuration can be saved without a model after discovery is unavailable',async()=>{
 const request=vi.fn(async(path:string,body?:any)=>path==='models/discover'?Promise.reject(Error('unavailable')):path==='models'&&body?{...body,hasKey:true}:path==='models/profiles'?{profiles:[],activeId:''}:null);
 render(<ModelSettings request={request}/>);
 fireEvent.change(screen.getByLabelText('服务地址'),{target:{value:'https://relay.example/v1'}});fireEvent.change(screen.getByLabelText('API 密钥'),{target:{value:'synthetic-key'}});
 fireEvent.click(screen.getByRole('button',{name:'加密保存配置'}));
 await waitFor(()=>expect(request).toHaveBeenCalledWith('models',expect.objectContaining({model:'',apiKey:'synthetic-key'})));
 expect(await screen.findAllByText('地址和密钥已加密保存，模型暂未获取，尚不能生成文案。')).toHaveLength(2);
});

test('a delayed old relay response cannot overwrite a newer configuration',async()=>{
 let releaseOld:(value:any)=>void=()=>{};
 const request=vi.fn(async(path:string,body?:any)=>path==='models/discover'?(body.baseUrl==='https://old.example/v1'?new Promise(resolve=>{releaseOld=resolve;}):{models:['new-model']}):path==='models/profiles'?{profiles:[],activeId:''}:null);
 render(<ModelSettings request={request}/>);
 fireEvent.change(screen.getByLabelText('服务地址'),{target:{value:'https://old.example/v1'}});fireEvent.change(screen.getByLabelText('API 密钥'),{target:{value:'synthetic-key'}});
 fireEvent.click(screen.getByRole('button',{name:'获取文案模型列表'}));
 fireEvent.change(screen.getByLabelText('服务地址'),{target:{value:'https://new.example/v1'}});fireEvent.click(screen.getByRole('button',{name:'获取文案模型列表'}));
 await waitFor(()=>expect(screen.getByLabelText('文案模型')).toHaveValue('new-model'));
 releaseOld({models:['old-model']});
 await waitFor(()=>expect(screen.getByLabelText('文案模型')).toHaveValue('new-model'));
 expect(screen.queryByRole('option',{name:'old-model'})).toBeNull();
});
