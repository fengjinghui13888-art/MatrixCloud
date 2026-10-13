import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const config=JSON.parse(readFileSync(new URL('../connector-config.json',import.meta.url),'utf8'));
const child=spawn(process.execPath,[fileURLToPath(new URL('./connector.mjs',import.meta.url)),'--cloud-url',config.cloudUrl,'--onboard',...process.argv.slice(2)],{stdio:'inherit'});
child.on('error',()=>{console.error('连接器启动失败，请重新下载完整安装包');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
