import {render,screen,fireEvent,within} from '@testing-library/react';
import {GreyApp} from '../GreyApp';

test('comment and private-message leads have distinct regions and matching content',async()=>{
 const original=globalThis.fetch;
 const data={accounts:[{id:'a',name:'测试账号',handle:'qa',profile:'local:qa'}],notes:[],comments:[{id:'same',accountId:'a',author:'评论访客',body:'怎么报名'}],messages:[{id:'same',accountId:'a',author:'私信访客',body:'私信咨询',direction:'incoming'}],leads:[{id:'c-lead',accountId:'a',sourceCommentId:'same',status:'new',followUps:[]},{id:'d-lead',accountId:'a',sourceKind:'direct',sourceCommentId:'same',status:'new',followUps:[]}]};
 globalThis.fetch=vi.fn(async url=>new Response(JSON.stringify(url==='/api/auth/status'?{configured:true}:url==='/api/auth/session'?{username:'qa'}:url==='/api/operations'?data:null)));
 try{
  render(<GreyApp/>);await screen.findByText('已同步账号');fireEvent.click(screen.getByRole('button',{name:'线索中心'}));
  const comments=screen.getByRole('region',{name:'评论线索'}),messages=screen.getByRole('region',{name:'私信线索'});
  expect(within(comments).getByText('怎么报名')).toBeInTheDocument();expect(within(comments).queryByText('私信咨询')).toBeNull();
  expect(within(messages).getByText('私信咨询')).toBeInTheDocument();expect(within(messages).queryByText('怎么报名')).toBeNull();
  expect(within(comments).getByText('1 条')).toBeInTheDocument();expect(within(messages).getByText('1 条')).toBeInTheDocument();
  expect(within(comments).getByLabelText('跟进 c-lead')).toBeInTheDocument();expect(within(messages).getByLabelText('跟进 d-lead')).toBeInTheDocument();
 }finally{globalThis.fetch=original;}
});
