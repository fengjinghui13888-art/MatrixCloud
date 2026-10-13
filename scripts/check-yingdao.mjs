import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read-only readiness check matching the official localService queryAppList.
const userFolder=process.argv[2];
if(!userFolder){console.error('Usage: node scripts/check-yingdao.mjs <影刀用户文件夹>');process.exit(1);}
const apps=join(userFolder,'apps');
if(!existsSync(apps)){console.error('未找到 apps 目录，请检查影刀用户文件夹。');process.exit(2);}
const ready=[];let working=0;let invalid=0;
for(const entry of readdirSync(apps,{withFileTypes:true})){
  if(!entry.isDirectory())continue;
  if(!entry.name.endsWith('_Release')){working++;continue;}
  const file=join(apps,entry.name,'xbot_robot','package.json');
  try{const p=JSON.parse(readFileSync(file,'utf8'));if(p.robot_type==='app'&&p.name&&p.uuid)ready.push({id:p.uuid,name:p.name});else invalid++;}catch{invalid++;}
}
console.log(JSON.stringify({readyApps:ready,workingFolders:working,invalidReleases:invalid,collectionExecuted:false},null,2));
if(!ready.length){console.error('官方本地连接器尚无可列出的已发布应用。需要在影刀中获取并运行采集应用，生成有效 _Release 包。');process.exitCode=2;}
