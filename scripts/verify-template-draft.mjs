import fs from 'node:fs';
const token=fs.readFileSync('/app/work/grey/access-token','utf8').trim();
const api=async(path,body)=>{const response=await fetch('http://127.0.0.1:4174/api/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw Error(result.message||String(response.status));return result;};
const id='2e55bb73-73f9-4dc2-8431-fb89aef4d609';
let task=await api('studio/'+id);
if(task.requestId!=='template-live-reference-20260915-01')throw Error('Wrong acceptance task');
if(process.argv[2]==='approve'&&task.status==='review')task=await api('studio/'+id+'/review',{revision:task.revision,decision:'approve'});
console.log(JSON.stringify({id:task.id,accountId:task.accountId,title:task.title,status:task.status,message:task.message,elapsed:task.executionElapsedMs}));
