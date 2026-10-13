import {test,expect} from 'vitest';
import {findTopicCandidate,readNativeTopics,fillNativeTopics} from '../../scripts/studio-topics.mjs';
import {verifyPersistedDraft} from '../../scripts/studio-persisted-draft.mjs';
import {verifyEditor} from '../../scripts/studio-page.mjs';
test('plain hashtag text cannot pass native editor verification',()=>{expect(()=>verifyEditor({editor:true,title:'标题',text:'正文\n#生活',imageCount:1,topics:[]},{title:'标题',body:'正文',tags:['生活'],images:['image']})).toThrow('话题');});
test.each(['#生活\u00a0\u00a0#日常 ', '#生活#日常', '#生活\n#日常'])('native topic spacing does not change the verified copy: %s',suffix=>{
 const task={title:'标题',body:'第一段\n\n第二段',tags:['生活','日常'],images:['image']};
 const actual={editor:true,title:task.title,text:task.body+'\n'+suffix,imageCount:1,topics:task.tags.map(name=>({name,id:name,link:'topic:'+name}))};
 expect(verifyEditor(actual,task)).toEqual({title:task.title,body:task.body,tags:task.tags,imageCount:1});
 expect(()=>verifyEditor({...actual,text:actual.text+'额外正文'},task)).toThrow('正文');
 expect(()=>verifyEditor({...actual,text:actual.text.replace('第一段','变更正文')},task)).toThrow('正文');
});
test('clicks only exact platform topic candidates with IDs',()=>{
 document.body.innerHTML='<button>生活</button><div class="item"><span class="name">#生活</span></div><div class="item" data-impression=\'{"tagTarget":{"value":{"tagId":"real-id"}}}\'><span class="name">#生活记录</span></div>';
 const e=document.querySelector('[data-impression]');e.getBoundingClientRect=()=>({width:100,height:20,x:10,y:20});e.scrollIntoView=()=>{};
 expect(findTopicCandidate('生活')).toBeNull();expect(findTopicCandidate('生活记录')).toEqual({id:'real-id',x:60,y:30});
});
test('missing topic fails instead of reporting a plain hashtag as selected',async()=>{
 const writes=[];const evaluate=async script=>script.includes('findTopicCandidate')?null:true;
 await expect(fillNativeTopics({page:{insertText:async x=>writes.push(x)},evaluate},['不存在'],{timeout:0})).rejects.toThrow('同名候选');expect(writes).toEqual(['#','不存在']);
});
test('persisted topics require native suffix, IDs, exact names and current files',()=>{
 const task={title:'标题',body:'正文',tags:['生活'],images:['image']};const row={title:'标题',body:'正文\n#生活[话题]#',tags:[{name:'生活',id:'id',link:'xhsdiscover://topic/id'}],images:[{fileId:'file',status:2}]};
 const wrap=r=>({available:true,matches:1,records:[r]});
 expect(verifyPersistedDraft(wrap(row),task,['file'],{requireNativeTopics:true}).tags).toEqual(['生活']);
 expect(()=>verifyPersistedDraft(wrap({...row,body:'正文\n#生活',tags:[]}),task,['file'],{requireNativeTopics:true})).toThrow('真实话题');
 expect(()=>verifyPersistedDraft(wrap({...row,tags:[{name:'生活'}]}),task,['file'],{requireNativeTopics:true})).toThrow();
});
test.each(['#生活[话题]#\u00a0\u00a0#日常[话题]# ', '#生活[话题]##日常[话题]#', '#生活[话题]#\n#日常[话题]#'])('persisted native topics tolerate their separator layout: %s',suffix=>{
 const task={title:'标题',body:'第一段\n\n第二段',tags:['生活','日常'],images:['image']};
 const row={title:task.title,body:task.body+'\n'+suffix,tags:task.tags.map(name=>({name,id:name,link:'topic:'+name})),images:[{fileId:'file',status:2}]};
 const wrap=r=>({available:true,matches:1,records:[r]});
 expect(verifyPersistedDraft(wrap(row),task,['file'],{requireNativeTopics:true}).body).toBe(task.body);
 expect(()=>verifyPersistedDraft(wrap({...row,body:row.body+'额外正文'}),task,['file'],{requireNativeTopics:true})).toThrow();
 expect(()=>verifyPersistedDraft(wrap({...row,body:row.body.replace('第一段','变更正文')}),task,['file'],{requireNativeTopics:true})).toThrow();
 expect(()=>verifyPersistedDraft(wrap(row),task,['another-file'],{requireNativeTopics:true})).toThrow('图片');
});
