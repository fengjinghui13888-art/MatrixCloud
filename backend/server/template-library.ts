import { runSqlite } from './sqlite-client';
import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { templateCategories,type TemplateContent,type ManagedTemplate,type LibraryTemplate } from '../../shared/templates';

export const templateInput=z.object({name:z.string().trim().min(1).max(100),category:z.enum(templateCategories),title:z.string().trim().min(1).max(20),body:z.string().trim().max(1000),images:z.array(z.union([z.string().url().startsWith('https://'),z.string().regex(/^\/api\/templates\/media\/[a-f0-9]{64}\.(png|jpg|webp)$/)])).min(1).max(9),sourceUrl:z.union([z.literal(''),z.string().url().startsWith('https://')]),usage:z.enum(['reference','owned','licensed']),rightsNote:z.string().trim().max(1000)}).strict();
export function createTemplateLibrary(path:string){
 const sql=(s:string)=>runSqlite(path,s).trim();
  const q=(s:string)=>"'"+s.replaceAll("'","''")+"'";
  const read=(s:string):ManagedTemplate[]=>{const text=sql(s);return text?text.split('\n').map(line=>JSON.parse(line)):[];};
  const fingerprint=(d:TemplateContent)=>createHash('sha256').update(JSON.stringify([d.title.normalize('NFKC').replace(/\s/g,''),d.body.normalize('NFKC').replace(/\s/g,''),d.images])).digest('hex');
  sql('CREATE TABLE IF NOT EXISTS template_library(id TEXT PRIMARY KEY,fingerprint TEXT UNIQUE NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL);');
  const list=()=>read('SELECT payload FROM template_library ORDER BY rowid DESC;');
  const get=(id:string)=>{const row=read(`SELECT payload FROM template_library WHERE id=${q(id)};`)[0];if(!row)throw Error('模板不存在');return row;};
  const save=(row:ManagedTemplate,expected:number)=>{const changed=sql(`UPDATE template_library SET payload=${q(JSON.stringify(row))},revision=${row.revision},fingerprint=${q(fingerprint(row.draft))} WHERE id=${q(row.id)} AND revision=${expected};SELECT changes();`);if(changed!=='1')throw Error('模板已更新，请刷新后重试');return row;};
  return {
    list,
    deleteMany(ids:string[]){sql(`DELETE FROM template_library WHERE id IN (${ids.map(q).join(',')})`);},
    published:()=>list().flatMap(row=>row.published?[row.published]:[]),
    create(raw:unknown){const draft=templateInput.parse(raw);const row:ManagedTemplate={id:randomUUID(),revision:1,draft,published:null,updatedAt:new Date().toISOString()};const fp=fingerprint(draft);sql(`INSERT OR IGNORE INTO template_library VALUES(${q(row.id)},${q(fp)},1,${q(JSON.stringify(row))});`);return read(`SELECT payload FROM template_library WHERE fingerprint=${q(fp)};`)[0];},
    update(id:string,raw:unknown,expected:number){const old=get(id);if(old.revision!==expected)throw Error('模板已更新，请刷新后重试');return save({...old,draft:templateInput.parse(raw),revision:expected+1,updatedAt:new Date().toISOString()},expected);},
    publish(id:string,expected:number){const row=get(id);if(row.revision!==expected)throw Error('模板已更新，请刷新后重试');if(row.draft.usage!=='reference'&&!row.draft.rightsNote)throw Error('请填写来源授权说明');const published:LibraryTemplate={...row.draft,id,revision:row.revision,updatedAt:new Date().toISOString()};return save({...row,published},expected);},
    unpublish(id:string,expected:number){const row=get(id);if(row.revision!==expected)throw Error('模板已更新，请刷新后重试');return save({...row,published:null},expected);}
  };
}
