import {it,expect,vi} from 'vitest';
import {clickDraftButton} from '../../scripts/studio-save-button.mjs';
import {saveAndConfirmDraft} from '../../scripts/studio-draft-flow.mjs';
const node=(name,id)=>({role:{value:'button'},name:{value:name},backendDOMNodeId:id,properties:[]});
it('clicks the exact accessible draft button, never the publish button or private handler',async()=>{
 const nativeClick=vi.fn();
 const cdp=vi.fn(async(method,args)=>method==='Accessibility.getFullAXTree'?{nodes:[node('发布',1),node('暂存离开',2)]}:{model:{content:[10,20,110,20,110,60,10,60]}});
 await clickDraftButton({cdp,nativeClick});
 expect(cdp).toHaveBeenLastCalledWith('DOM.getBoxModel',{backendNodeId:2});
 expect(nativeClick).toHaveBeenCalledTimes(1);expect(nativeClick).toHaveBeenCalledWith(60,40);
});
it.each([[],[node('发布',1)],[node('暂存离开',1),node('暂存离开',2)],[{...node('暂存离开',1),properties:[{name:'disabled',value:{value:true}}]}]].map(nodes=>({nodes})))('refuses absent, disabled or ambiguous draft buttons (%j)',async ({nodes})=>{
 const nativeClick=vi.fn();await expect(clickDraftButton({cdp:async()=>({nodes}),nativeClick})).rejects.toThrow('暂存');expect(nativeClick).not.toHaveBeenCalled();
});
it('save orchestration uses the native action once and never retries an unknown outcome',async()=>{
 const save=vi.fn(async()=>{throw Error('command_result_unknown');}),evaluate=vi.fn(async()=>({available:true,matches:0}));
 await expect(saveAndConfirmDraft(evaluate,'标题',{save})).rejects.toThrow('command_result_unknown');
 expect(save).toHaveBeenCalledTimes(1);expect(evaluate).toHaveBeenCalledTimes(1);
});
