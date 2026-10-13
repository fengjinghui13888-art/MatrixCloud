// The site places its draft button in a closed shadow root. Read the browser's
// accessible button identity and click its actual bounds, preserving blur and
// pointer events. Never infer a coordinate from the neighbouring Publish button.
export async function clickDraftButton(page) {
 const {nodes}=await page.cdp('Accessibility.getFullAXTree');
 const buttons=(nodes??[]).filter(n=>!n.ignored&&n.role?.value==='button'&&['暂存离开','存草稿','保存草稿'].includes(n.name?.value)&&n.backendDOMNodeId&&!n.properties?.some(p=>p.name==='disabled'&&p.value?.value===true));
 if(buttons.length!==1)throw Error(`暂存按钮不可用或不唯一：${buttons.length}`);
 const {model}=await page.cdp('DOM.getBoxModel',{backendNodeId:buttons[0].backendDOMNodeId});
 const q=model?.content;
 if(!Array.isArray(q)||q.length!==8||!q.every(Number.isFinite)||q[2]<=q[0]||q[5]<=q[1])throw Error('暂存按钮没有可点击区域');
 await page.nativeClick((q[0]+q[2]+q[4]+q[6])/4,(q[1]+q[3]+q[5]+q[7])/4);
}
