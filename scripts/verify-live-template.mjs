import fs from 'node:fs';
const token=fs.readFileSync('/app/work/grey/access-token','utf8').trim();
const api=async(path,body)=>{const response=await fetch('http://127.0.0.1:4174/api/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw Error(result.message||String(response.status));return result;};
const raw=fs.readFileSync('/tmp/template-reference.png');
const uploaded=await api('templates/upload',{fileName:'验收素材-书桌.png',data:'data:image/png;base64,'+raw.toString('base64')});
const accounts=await api('accounts');
const t=await api('studio/generate',{accountId:accounts[0].id,topic:'分享干净整洁的工作桌面，保持参考图片中的主体，改变背景和光线。',persona:'生活分享',style:'自然摄影',imageCount:1,size:'1024x1024',requestId:'template-live-reference-20260915-01',confirmCharge:true,imageMode:'reference',templateIds:[uploaded.item.id],strength:0.6});
console.log(JSON.stringify({taskId:t.id,status:t.status,message:t.message,title:t.title,images:t.images,templateId:uploaded.item.id,model:(await api('models')).imageModel}));
if(t.status!=='review')process.exitCode=1;
