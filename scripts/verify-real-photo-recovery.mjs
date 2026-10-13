import fs from 'node:fs';
import assert from 'node:assert/strict';
const token=fs.readFileSync('/app/work/grey/access-token','utf8').trim();
const id='4659dcb4-4e06-4f50-8fc3-8d5f0736ed3d';
const api=async(path,body)=>{
  const response=await fetch('http://127.0.0.1:4174/api/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const result=await response.json();if(!response.ok)throw Error(result.message||String(response.status));return result;
};
let task=await api('studio/'+id);
assert.equal(task.accountId,'xhs-11839495135');
assert.deepEqual(task.templateIds,['723d9347-c8c8-4be0-89cd-bd8259788a00']);
if(process.argv[2]==='resume'){
  assert.equal(task.status,'generation_failed');
  task=await api('studio/'+id+'/resume?async=1',{revision:task.revision,confirmCharge:true});
}
if(process.argv[2]==='draft'){
  assert.equal(task.status,'review');
  task=await api('studio/'+id+'/review',{revision:task.revision,decision:'approve'});
}
const library=await api('templates/mine');
console.log(JSON.stringify({id:task.id,status:task.status,title:task.title,bodyLength:task.body.length,images:task.images,message:task.message,revision:task.revision,accountId:task.accountId,templateIds:task.templateIds,history:task.history,returnedToLibrary:task.images.length>0&&task.images.every(image=>library.items.some(t=>t.images.includes(image)))}));
