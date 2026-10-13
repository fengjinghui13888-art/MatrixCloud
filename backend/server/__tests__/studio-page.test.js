import { describe, expect, it } from 'vitest';
import { verifyEditor } from '../../../scripts/studio-page.mjs';
const task={title:'测试',body:'第一段\n\n第二段 #正文标签',tags:['汽车','提车'],images:['https://example.com/a.jpg']};
const actual={editor:true,title:task.title,text:task.body+'\n#汽车 #提车',imageCount:1};
describe('editor evidence',()=>{
 it('returns body and tags read from the editor',()=>expect(verifyEditor(actual,task)).toEqual({title:task.title,body:task.body,tags:task.tags,imageCount:1}));
 it('rejects changed paragraph structure',()=>expect(()=>verifyEditor({...actual,text:actual.text.replace('\n\n',' ')},task)).toThrow());
 it('rejects a missing editor',()=>expect(()=>verifyEditor({...actual,editor:false},task)).toThrow());
 it('rejects literal backslash n',()=>expect(()=>verifyEditor({...actual,text:task.body+'\\n#汽车 #提车'},task)).toThrow());
 it('rejects missing or extra tags',()=>expect(()=>verifyEditor({...actual,text:actual.text+' #多余'},task)).toThrow());
 it('rejects missing previews',()=>expect(()=>verifyEditor({...actual,imageCount:0},task)).toThrow());
});

it('serialized browser writer inserts real newlines and emits the actual input',async()=>{
 const {fillEditor}=await import('../../../scripts/studio-page.mjs');
 document.body.innerHTML='<div id="web"><input placeholder="标题"><div contenteditable="true"></div></div>';
 const body=document.querySelector('[contenteditable]');
 let written;
 body.addEventListener('input',event=>{written=event.data;});
 // Exercise the exact function serialization used by the executor.
 (0,eval)(`(${fillEditor.toString()})(${JSON.stringify(task)})`);
 expect(written).toBe(task.body+'\n#汽车 #提车');
 expect([...body.children].map(p=>p.textContent).join('\n')).toBe(written);
 expect(document.querySelector('input').value).toBe(task.title);
});

it('reads ProseMirror paragraphs without CSS-generated extra line breaks',async()=>{
 const {readEditor}=await import('../../../scripts/studio-page.mjs');
 document.body.innerHTML='<div id="web"><input placeholder="标题"><div contenteditable="true" class="ProseMirror"><p>第一行</p><p><br></p><p>第二行</p></div></div>';
 expect(readEditor().text).toBe('第一行\n\n第二行');
});

it('extracts tags after canonicalizing editor-created blank paragraphs',()=>{
 expect(verifyEditor({...actual,text:actual.text.replace('\n\n','\n\n\n\n')},task)).toEqual({title:task.title,body:task.body,tags:task.tags,imageCount:1});
});
