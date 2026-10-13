import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {hostname} from 'node:os';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {normalizeCloudUrl} from './cloud-client.mjs';

try {
  const config = JSON.parse(readFileSync(new URL('../connector-config.json', import.meta.url), 'utf8'));
  const cloudUrl = normalizeCloudUrl(config.cloudUrl);
  if (new URL(cloudUrl).protocol !== 'https:') throw Error('配对配置必须使用 HTTPS 工作台地址');
  const reader = createInterface({input: process.stdin, output: process.stdout});
  const lines = reader[Symbol.asyncIterator]();
  const ask = async prompt => {
    process.stdout.write(prompt);
    const {value, done} = await lines.next();
    if (done) throw Error('配对已取消，请重新打开恢复配对入口');
    return value.trim();
  };
  let code, deviceName;
  try {
    code = await ask('请输入工作台生成的 8 位配对码：');
    if (!/^\d{8}$/.test(code)) throw Error('配对码应为 8 位数字');
    deviceName = (await ask('这台电脑名称（可直接回车）：')) || hostname();
  } finally {
    reader.close();
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./connector.mjs', import.meta.url)), '--cloud-url', cloudUrl, '--pairing-code', code, '--device-name', deviceName], {stdio: 'inherit', shell: false});
  child.once('error', () => {console.error('连接器启动失败，请重新下载完整安装包'); process.exitCode = 1;});
  child.once('exit', value => {process.exitCode = value ?? 1;});
} catch (error) {
  console.error(error.message || '配对未完成，请重新打开恢复配对入口');
  process.exitCode = 1;
}
