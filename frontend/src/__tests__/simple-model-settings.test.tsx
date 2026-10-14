import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {ModelSettings} from '../ModelSettings';
test('preset plus key saves without entering URL or technical fields',async()=>{
 const request=vi.fn(async(path:string,body?:any)=>path==='models'&&body?{...body,hasKey:true}:path==='models/profiles'?{activeId:'',profiles:[]}:null);
 render(<ModelSettings request={request}/>);
 fireEvent.click(screen.getByRole('button',{name:'DeepSeek'}));
 fireEvent.change(screen.getByLabelText(/^API 密钥/),{target:{value:'test-only-secret'}});
 fireEvent.click(screen.getByRole('button',{name:'加密保存配置'}));
 await waitFor(()=>expect(request).toHaveBeenCalledWith('models',expect.objectContaining({label:'DeepSeek',baseUrl:'https://api.deepseek.com',model:'deepseek-chat',apiKey:'test-only-secret'})));
 expect(screen.queryByText(/仅支持公网 HTTPS/)).toBeNull();
 expect(screen.getByLabelText(/^API 密钥/)).toHaveValue('');
});
