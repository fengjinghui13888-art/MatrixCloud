import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {AccountLogin} from '../AccountLogin';
import {PasswordRecovery} from '../PasswordRecovery';

test('forgot password preserves username and returns to login after reset',async()=>{
 const calls:any[]=[];
 vi.stubGlobal('fetch',vi.fn(async(path,options)=>{
  if(String(path).endsWith('/status'))return new Response(JSON.stringify({configured:true}));
  if(String(path).endsWith('/session'))return new Response('{}',{status:401});
  calls.push({path,body:JSON.parse(options.body)});return new Response('{"ok":true}');
 }));
 render(<AccountLogin>{()=>null}</AccountLogin>);
 fireEvent.change(await screen.findByLabelText('账号'),{target:{value:'pagecheck'}});
 fireEvent.click(screen.getByRole('button',{name:'忘记密码？'}));
 expect(screen.getByRole('heading',{name:'重设登录密码'})).toBeInTheDocument();
 expect(screen.getByLabelText('账号')).toHaveValue('pagecheck');
 fireEvent.change(screen.getByLabelText('一次性恢复码'),{target:{value:'synthetic-code'}});
 for(const label of ['新密码','确认新密码'])fireEvent.change(screen.getByLabelText(label),{target:{value:'synthetic-password'}});
 fireEvent.click(screen.getByRole('button',{name:'重设密码'}));
 expect(await screen.findByRole('status')).toHaveTextContent('密码已重设');
 expect(calls).toEqual([{path:'/api/auth/password-reset',body:{username:'pagecheck',code:'synthetic-code',password:'synthetic-password'}}]);
 expect(screen.getByLabelText('密码')).toHaveValue('');
});

test('mismatched passwords do not submit and invalid recovery errors stay visible',async()=>{
 const submit=vi.fn().mockRejectedValue(Error('恢复码无效或已过期'));
 render(<PasswordRecovery initialUsername="customer" onBack={()=>{}} onComplete={()=>{}} submit={submit}/>);
 fireEvent.change(screen.getByLabelText('一次性恢复码'),{target:{value:'synthetic'}});
 fireEvent.change(screen.getByLabelText('新密码'),{target:{value:'synthetic-password'}});
 fireEvent.change(screen.getByLabelText('确认新密码'),{target:{value:'different-password'}});
 fireEvent.click(screen.getByRole('button',{name:'重设密码'}));
 expect(screen.getByRole('alert')).toHaveTextContent('不一致');expect(submit).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('确认新密码'),{target:{value:'synthetic-password'}});
 fireEvent.click(screen.getByRole('button',{name:'重设密码'}));
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('已过期'));
});
