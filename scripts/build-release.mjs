import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONNECTOR_PLATFORMS } from '../shared/connector-platforms.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cloudUrl = value('--cloud-url');
let origin;
try { const url=new URL(cloudUrl); if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Error(); origin=url.origin; } catch { throw new Error('必须使用 --cloud-url 传入无凭证的 HTTPS 工作台地址'); }
const output = resolve(value('--output') ?? join(root, 'outputs', `matrix-cloud-release-${new Date().toISOString().slice(0, 10)}`));
if (existsSync(output)) throw new Error(`输出目录已存在，为避免覆盖请换一个路径：${output}`);
mkdirSync(join(output, 'source'), { recursive: true });
const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const untracked = execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const sourceRoots = /^(frontend|backend|server|src|scripts|shared|local-connector|workbuddy-connector|public|deploy|migration)\//;
const sourceFiles = new Set(['.gitignore','.dockerignore','.editorconfig','.gitattributes','.node-version','.npmrc','.env.example','Dockerfile','index.html','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','tsconfig.node.json','vite.config.ts','postcss.config.js','tailwind.config.js','START-CONNECTOR.bat','START-LOCAL-DEV.bat','README.md','DEVELOPMENT.md','ARCHITECTURE.md','OPERATIONS.md','RELEASE.md','compose.dev.yaml','compose.prod.example.yaml','railway.json','render.yaml']);
for(const name of ['tsconfig.base.json','vitest.config.ts','SOURCE-SNAPSHOT.json','docs/文件与代码删除指南.md','docs/file-deletion-inventory.csv','docs/dependency-analysis.json'])sourceFiles.add(name);
const allowedExtension=/\.(?:[cm]?js|[cm]?tsx?|json|sql|conf|service|Dockerfile|css|html|svg|png|jpe?g|webp|gif|ico|py|ps1|bat|sh|txt|ya?ml|md)$|(?:^|\/)Dockerfile$/i;
const excludedFile=/(?:^|\/)(?:\.env(?:\..+)?|cloud-device\.json|connector-token|model-encryption-key|device-lease\.json|[^/]+\.local\.json)$|\.(?:pem|key|pub|pfx|p12|sqlite|db|log|pyc)$/i;
const included=[];
for (const file of [...new Set([...tracked,...untracked])].sort()) {
  if (!(sourceFiles.has(file)||(sourceRoots.test(file)&&allowedExtension.test(file)&&!excludedFile.test(file)))) continue;
  const source=join(root,file);if(!existsSync(source))continue;
  if(!lstatSync(source).isFile())throw Error('交付源码必须是普通文件：'+file);
  const target = join(output, 'source', file);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);included.push(file);
}
for (const file of ['README.md', 'DEVELOPMENT.md', 'ARCHITECTURE.md', 'OPERATIONS.md', 'RELEASE.md', '.env.example', 'compose.dev.yaml', 'compose.prod.example.yaml']) {
  if (existsSync(join(root, file))) { mkdirSync(dirname(join(output, file)), { recursive: true }); copyFileSync(join(root, file), join(output, file)); }
}
for (const file of ['docs/customer-delivery.md','docs/windows-local-connector.md', 'docs/maintenance-mcp-portable.md', 'migration/README.md']) {
  if (existsSync(join(root, file))) { mkdirSync(dirname(join(output, file)), { recursive: true }); copyFileSync(join(root, file), join(output, file)); }
}
mkdirSync(join(output, 'config'), { recursive: true });
copyFileSync(join(root, '.env.example'), join(output, 'config', '.env.example'));
const connectors = value('--connector-dir');
const connectorNames = CONNECTOR_PLATFORMS.map(item=>item.filename);
mkdirSync(join(output, 'connectors'), { recursive: true });
if (connectors) for (const name of connectorNames) { const source = join(resolve(connectors), name); if (existsSync(source)) copyFileSync(source, join(output, 'connectors', name)); }
mkdirSync(join(output, 'migration'), { recursive: true });
if (!existsSync(join(output, 'migration', 'README.md'))) writeFileSync(join(output, 'migration', 'README.md'), `# 生产迁移包\n\n生产数据库、媒体、密钥和浏览器状态不进入源码交接包。请使用受控备份工具生成单独加密快照，在停写窗口导入新环境，并核对用户、工作区、账号、内容、素材、任务和媒体引用数量。\n\n当前发布地址：${cloudUrl}\n`);
const files = [];
const walk = (dir) => { for (const name of readdirSync(dir)) { const file = join(dir, name); const info = statSync(file); if (info.isDirectory()) walk(file); else { const path = relative(output, file).replaceAll('\\', '/'); if (path === 'RELEASE-MANIFEST.json' || path === 'checksums.sha256') continue; const data = readFileSync(file); files.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') }); } } };
walk(output);
const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty=!!execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim();
const manifest = { format: 2, builtAt: new Date().toISOString(), commit, source:{baseCommit:commit,dirty,untrackedIncluded:included.filter(file=>untracked.includes(file))},cloudUrl:origin, node: '22.14.0', pnpm: '11.25.0', productionData: 'separate-encrypted-migration-package', files: files.sort((a, b) => a.path.localeCompare(b.path)) };
writeFileSync(join(output, 'RELEASE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(output, 'checksums.sha256'), files.map(file => `${file.sha256}  ${file.path}`).join('\n') + '\n');
execFileSync(process.env.PYTHON ?? (process.platform==='win32'?'python':'python3'), ['-c', "import os,shutil,sys; shutil.make_archive(sys.argv[2], 'zip', root_dir=sys.argv[1], base_dir=os.path.basename(sys.argv[2]))", dirname(output), output], { stdio: 'inherit' });
console.log(JSON.stringify({ output, archive:output+'.zip',commit,dirty,files:files.length,cloudUrl:origin }, null, 2));
