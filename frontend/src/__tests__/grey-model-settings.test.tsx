import { render,screen,fireEvent,waitFor } from '@testing-library/react';
import { GreyApp } from '../GreyApp';
import { ModelSettings } from '../ModelSettings';

test('text and image prompts remain independent and submit to their respective services',async()=>{
  const request=vi.fn(async(path:string)=>path==='models'?{label:'Test',protocol:'chat-completions',baseUrl:'https://example.com',model:'text',imageModel:'image',hasKey:true}:path==='models/chat'?{text:'ok'}:{images:[]});
  render(<ModelSettings request={request}/>);
  await waitFor(()=>expect(screen.getByLabelText('文案模型')).toHaveValue('text'));
  const text=screen.getByLabelText('发送给模型的文本'),image=screen.getByLabelText('图片提示词');
  fireEvent.change(text,{target:{value:'写一篇文案'}});
  expect(image).toHaveValue('');
  fireEvent.change(image,{target:{value:'画一片森林'}});
  expect(text).toHaveValue('写一篇文案');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button',{name:'调用所选模型'}));
  await waitFor(()=>expect(request).toHaveBeenCalledWith('models/chat',{prompt:'写一篇文案',confirmCharge:true}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'生成图片'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'生成图片'}));
  await waitFor(()=>expect(request).toHaveBeenCalledWith('models/images',{prompt:'画一片森林',confirmCharge:true,count:1}));
});

test('customer can save a model choice without exposing or retaining the entered key',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=vi.fn(async (url,init)=>{
    if(url==='/api/auth/status')return new Response(JSON.stringify({configured:true}));
    if(url==='/api/auth/session')return new Response(JSON.stringify({username:'fixture'}));
    if(url==='/api/operations')return new Response(JSON.stringify({accounts:[],notes:[],comments:[],leads:[]}));
    if(url==='/api/models'&&init?.method==='POST')return new Response(JSON.stringify({label:'Fixture',protocol:'chat-completions',baseUrl:'https://provider.example/v1',model:'fixture',hasKey:true}));
    return new Response('null');
  });
  try{
    render(<GreyApp/>);
    await screen.findByText('已同步账号');
    fireEvent.click(screen.getByRole('button',{name:'连接设置'}));
    fireEvent.change(await screen.findByLabelText('服务名称'),{target:{value:'Fixture'}});
    fireEvent.change(screen.getByLabelText('服务地址'),{target:{value:'https://provider.example/v1'}});
    fireEvent.change(screen.getByLabelText('模型名称'),{target:{value:'fixture'}});
    fireEvent.change(screen.getByLabelText(/^API 密钥/),{target:{value:'test-secret'}});
    fireEvent.click(screen.getByRole('button',{name:'加密保存配置'}));
    await waitFor(()=>expect(screen.getByLabelText(/^API 密钥/)).toHaveValue(''));
    expect(screen.queryByText('test-secret')).not.toBeInTheDocument();
  }finally{globalThis.fetch=original;}
});
