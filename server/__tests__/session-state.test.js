import {readSession} from '../../local-connector/session-state.mjs';
test('status polling never activates or navigates tabs, including unknown web identity',async()=>{
 const c={activate:vi.fn(),evaluate:vi.fn().mockResolvedValueOnce({loggedIn:true,handle:'123',name:'A'}).mockResolvedValueOnce({loggedIn:false,status:'unknown',url:'about:blank'}),close:vi.fn(),page:{selectTab:vi.fn(),goto:vi.fn()}};
 const info=await readSession({}, {connectPage:async()=>c,findOrOpenWebPage:async()=>'web'});
 expect(info.stage).toBe('web');expect(c.page.goto).not.toHaveBeenCalled();expect(c.activate).not.toHaveBeenCalled();expect(c.close).toHaveBeenCalledOnce();
});
test('two logged-in pages without matching identifiers are not ready',async()=>{
 const c={activate:vi.fn(),evaluate:vi.fn().mockResolvedValueOnce({loggedIn:true,handle:'',name:'A'}).mockResolvedValueOnce({loggedIn:true,redId:'123',name:'A'}),close:vi.fn(),page:{selectTab:vi.fn()}};
 const info=await readSession({}, {connectPage:async()=>c,findOrOpenWebPage:async()=>'web'});expect(info.loggedIn).toBe(false);expect(info.stage).not.toBe('ready');
});
