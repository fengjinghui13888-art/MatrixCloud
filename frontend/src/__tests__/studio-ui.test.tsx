import { render,screen,fireEvent,waitFor } from '@testing-library/react';
import { OneClickPublish } from '../OneClickPublish';
test('retains original reference controls and submits a twelve image creation without new budgets',async()=>{
 const calls:{path:string;body:any}[]=[];
 const request=async(path:string,body?:any)=>{calls.push({path,body});return path==='studio'?[]:path==='models'?{model:'original-text',imageModel:'original-image'}:{id:'new',revision:1,title:'',body:'',tags:[],images:[],status:'generating',message:'生成中'};};
 const account={id:'a',name:'账号',handle:'123',profile:'local:a',avatar:'',state:'connected' as const,followers:0,lastSyncedAt:''};
 render(<OneClickPublish accounts={[account]} request={request}/>);
 fireEvent.change(screen.getByLabelText('选题'),{target:{value:'十二张图'}});
 fireEvent.change(screen.getByLabelText('图片数量'),{target:{value:'12'}});
 fireEvent.click(screen.getByRole('button',{name:'生成图文'}));
 await waitFor(()=>expect(calls.find(c=>c.path==='studio/generate?async=1')?.body).toMatchObject({imageCount:12,imageMode:'direct'}));
 fireEvent.click(screen.getByRole('tab',{name:'素材二创'}));
 expect(screen.getByRole('slider',{name:'二创强度'})).toHaveValue('0.6');
 expect(calls.some(c=>c.path==='costs')).toBe(false);
});
test('failed text offers continuation on the same task and asynchronous copy populates the editor',async()=>{
 let task={id:'failed',revision:2,status:'generation_failed',topic:'实拍素材',title:'',body:'',tags:[],images:[],message:'文案生成失败',imageCount:1};
 const calls:string[]=[];
 const request=async(path:string)=>{calls.push(path);if(path==='studio')return [task];if(path==='models')return {};if(path==='studio/failed/resume?async=1'){task={...task,revision:3,status:'generating'};return task;}return null;};
 render(<OneClickPublish accounts={[{id:'a',name:'账号',handle:'a',profile:'local:a',avatar:'',state:'connected' as const,followers:0,lastSyncedAt:''}]} request={request}/>);
 fireEvent.click(await screen.findByRole('button',{name:'实拍素材'}));
 fireEvent.click(screen.getByRole('button',{name:'继续生成'}));
 await waitFor(()=>expect(calls).toContain('studio/failed/resume?async=1'));
 task={...task,revision:4,status:'review',title:'新标题',body:'新正文'};
 await waitFor(()=>expect(screen.getByLabelText('正文')).toHaveValue('新正文'),{timeout:3000});
 expect(screen.getByRole('button',{name:'保存到小红书草稿'})).toBeEnabled();
});
test('restores editable review draft and blocks approval while edits are unsaved',async()=>{
 const request=async(path:string)=>path==='studio'?[{id:'test-task',revision:1,status:'review',title:'已生成标题',body:'待审核正文',tags:['标签'],images:['https://example.com/image.png'],message:'待审核',imageCount:1}]:null;
 render(<OneClickPublish accounts={[]} request={request}/>);
 fireEvent.click(await screen.findByRole('button',{name:/已生成标题/}));
 expect(screen.getByLabelText('标题')).toHaveValue('已生成标题');
 fireEvent.change(screen.getByLabelText('标题'),{target:{value:'编辑后的标题'}});
 expect(screen.getByRole('button',{name:'保存到小红书草稿'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'保存修改'})).toBeEnabled();
});

test('task progress is not repeated under generation and completed tasks explain where drafts live',async()=>{
 const request=async()=>[{id:'saved-task',revision:1,status:'filled',title:'已保存标题',body:'正文',tags:[],images:[],message:'已在草稿箱核对内容',imageCount:1}];
 render(<OneClickPublish accounts={[]} request={request}/>);
 fireEvent.click(await screen.findByRole('button',{name:'已保存标题'}));
 expect(screen.getAllByText('已在草稿箱核对内容')).toHaveLength(1);
 expect(screen.getByText(/手机和其他浏览器不会自动同步/)).toHaveTextContent('执行电脑');
});
test('a safe pre-upload failure keeps an automatic sync recovery action visible',async()=>{
 const task={id:'blocked',revision:3,status:'blocked',title:'待继续草稿',body:'正文',tags:[],images:[],message:'页面尚未就绪',imageCount:1};
 const calls:string[]=[];const request=async(path:string)=>{calls.push(path);return path==='studio'?[task]:path==='models'?{}:task;};
 render(<OneClickPublish accounts={[]} request={request}/>);
 fireEvent.click(await screen.findByRole('button',{name:'待继续草稿'}));
 fireEvent.click(screen.getByRole('button',{name:'保存到小红书草稿'}));
 await waitFor(()=>expect(calls).toContain('studio/blocked/retry'));
});
test('unknown upload results cannot expose a blind retry action',async()=>{
 const task={id:'unknown',revision:3,status:'blocked',title:'结果未知',body:'正文',tags:[],images:[],message:'断线',imageCount:1,executionStartedAt:new Date().toISOString()};
 render(<OneClickPublish accounts={[]} request={async path=>path==='studio'?[task]:{}}/>);
 fireEvent.click(await screen.findByRole('button',{name:'结果未知'}));
 expect(screen.getByRole('button',{name:'保存到小红书草稿'})).toBeDisabled();
 expect(screen.getByText(/确认前不会重复上传/)).toBeInTheDocument();
});
test('an old pre-upload failure exposes recovery without asking the customer to regenerate',async()=>{
 const task={id:'legacy',revision:8,status:'blocked',title:'历史页面检查失败',body:'正文',tags:[],images:[],imageCount:1,message:'连接/页面检查失败：当前创作页已有未保存内容，已保留原页面；请核对后再同步',executionStartedAt:'2026-09-17T03:43:11.718Z'};
 const calls:string[]=[];
 render(<OneClickPublish accounts={[]} request={async path=>{calls.push(path);return path==='studio'?[task]:path==='models'?{}:task;}}/>);
 fireEvent.click(await screen.findByRole('button',{name:task.title}));
 fireEvent.click(screen.getByRole('button',{name:'保存到小红书草稿'}));
 await waitFor(()=>expect(calls).toContain('studio/legacy/retry'));
 expect(screen.queryByText(/确认前不会重复上传/)).not.toBeInTheDocument();
});
test('shows the actual offline execution computer and provides a connection entry',async()=>{
 const task={id:'offline',accountId:'a',revision:1,status:'review',title:'等待电脑',body:'正文',tags:[],images:[],message:'待审核',imageCount:1};
 const manage=vi.fn();const account={id:'a',name:'账号',handle:'123',profile:'local:a',avatar:'',state:'connected' as const,followers:0,lastSyncedAt:'',executionDevice:{id:'pc',name:'团队 Windows',online:false}};
 render(<OneClickPublish accounts={[account]} onManageAccounts={manage} request={async path=>path==='studio'?[task]:{}}/>);
 fireEvent.click(await screen.findByRole('button',{name:task.title}));
 expect(screen.getByText(/执行电脑：团队 Windows · 离线/)).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'查看账号与执行电脑'}));expect(manage).toHaveBeenCalledOnce();
});

test.each([
 ['review',undefined,'dispatch'], ['rejected',undefined,'review'], ['approved',undefined,'dispatch'],
 ['blocked',undefined,'retry'], ['filled',undefined,'dispatch'], ['published',undefined,null],
 ['pending_confirmation',undefined,null], ['filling','started',null], ['approved','started',null],
 ['blocked','started',null], ['generating',undefined,null], ['generation_failed',undefined,null],
])('all %s tasks share one publishing control with safe routing',async(status,executionStartedAt,route)=>{
 const task={id:'history',accountId:'a',revision:8,status,executionStartedAt,title:'历史任务',body:'正文',tags:[],images:[],imageCount:1,message:'状态提示'};
 const requests: {path:string;body:any}[]=[];
 render(<OneClickPublish accounts={[{id:'a',name:'账号',handle:'a',profile:'local:a',avatar:'',state:'connected' as const,followers:0,lastSyncedAt:''}]} request={async(path,body)=>{if(body)requests.push({path,body});return path==='studio'?[task]:path==='models'?{}:task;}}/>);
 fireEvent.click(await screen.findByRole('button',{name:task.title}));
 const action=screen.getByRole('button',{name:'保存到小红书草稿'});
 expect(action).toHaveClass('primary');
 expect(screen.getAllByRole('region',{name:'保存草稿'})).toHaveLength(1);
 if(route){fireEvent.click(action);fireEvent.click(action);await waitFor(()=>expect(requests).toHaveLength(1));expect(requests[0]).toMatchObject({path:`studio/history/${route}`,body:route==='dispatch'?{accountIds:['a']}:{revision:8}});}
 else {expect(action).toBeDisabled();fireEvent.click(action);expect(requests).toHaveLength(0);}
 if(executionStartedAt||['filled','published','pending_confirmation'].includes(status))expect(screen.getByLabelText('正文')).toBeDisabled();
});
test('saved task uses one action to synchronize every connected account',async()=>{
 const saved={id:'saved',accountId:'a',revision:8,status:'filled',title:'已保存任务',body:'正文',tags:[],images:[],imageCount:1,message:'已保存'};
 const accounts=['a','b'].map(id=>({id,name:`账号${id}`,handle:id,profile:`local:${id}`,avatar:'',state:'connected' as const,followers:0,lastSyncedAt:''}));
 const requests: {path:string;body:any}[]=[];
 render(<OneClickPublish accounts={accounts} request={async(path,body)=>{if(body)requests.push({path,body});return path==='studio'?[saved]:path==='models'?{}:{tasks:[saved]};}}/>);
 fireEvent.click(await screen.findByRole('button',{name:saved.title}));
 const action=screen.getByRole('button',{name:'保存到小红书草稿'});
 expect(screen.getByText('同步范围：全部已连接账号（2）')).toBeInTheDocument();
 expect(action).toBeEnabled();
 fireEvent.click(action);fireEvent.click(action);
 await waitFor(()=>expect(requests).toEqual([{path:'studio/saved/dispatch',body:{accountIds:['a','b'],revision:8}}]));
});
