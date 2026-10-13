import {realpathSync,statSync} from 'node:fs';
import {resolve,sep} from 'node:path';
export function createMediaArchive(dir:string){
 const root=resolve(dir,'media');
 return {file:(relative:string,accountId:string,noteId:string)=>{
  try{
   const segment=(v:string)=>encodeURIComponent(v).replace(/[.!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
   const parts=relative.split('/');if(parts.length!==5||parts[0]!==segment(accountId)||parts[3]!==segment(noteId))return null;
   if(relative.includes('\\')||relative.split('/').some(p=>p==='..'||p===''))return null;
   const base=realpathSync(root),file=realpathSync(resolve(root,relative));
   if(!file.startsWith(base+sep)||!statSync(file).isFile())return null;
   return file;
  }catch{return null;}
 }};
}
