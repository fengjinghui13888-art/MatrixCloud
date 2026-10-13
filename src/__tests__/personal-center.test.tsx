import { fireEvent,render,screen } from '@testing-library/react';
import { PersonalMenu,PersonalCenter } from '../PersonalCenter';

test('personal menu opens settings and switching invokes logout instead of silently closing',async()=>{
  const logout=vi.fn(async()=>{}),settings=vi.fn(),profile=vi.fn();
  render(<PersonalMenu username="owner" onProfile={profile} onSettings={settings} onLogout={logout}/>);
  fireEvent.click(screen.getByRole('button',{name:'打开个人中心'}));
  fireEvent.click(screen.getByRole('button',{name:'个人中心'}));expect(profile).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'打开个人中心'}));
  fireEvent.click(screen.getByRole('button',{name:'设置'}));expect(settings).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'打开个人中心'}));
  fireEvent.click(screen.getByRole('button',{name:'切换系统账号'}));expect(logout).toHaveBeenCalledOnce();
});
test('profile saves entered nickname and presents returned saved value',async()=>{
  const request=async(_path:string,body?:any)=>({username:'owner',displayName:body?.displayName??'Old name'});
  render(<PersonalCenter request={request}/>);
  const input=await screen.findByRole('textbox',{name:'昵称'});
  fireEvent.change(input,{target:{value:'New name'}});fireEvent.click(screen.getByRole('button',{name:'保存资料'}));
  await screen.findByText('个人资料已保存');expect(screen.getByRole('heading',{name:'New name'})).toBeInTheDocument();
});
