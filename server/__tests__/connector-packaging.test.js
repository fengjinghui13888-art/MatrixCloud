// @vitest-environment node
import {afterEach, expect, it} from 'vitest';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {access, link, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {tmpdir} from 'node:os';

const run = promisify(execFile), builder = resolve('scripts/build-connector-packages.py'), fixtures = [];
const pythonCommand = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const python = (await run(pythonCommand, ['-c', 'import sys; print(sys.executable)'])).stdout.trim();
const platforms = [
  ['windows-connector', 'matrix-cloud-windows-connector.zip', 'windows'],
  ['mac-connector-x64', 'matrix-cloud-mac-intel-connector.zip', 'mac-intel'],
  ['mac-connector-arm64', 'matrix-cloud-mac-apple-silicon-connector.zip', 'mac-arm64'],
];
async function put(file, content = 'fixture') {await mkdir(join(file, '..'), {recursive: true}); await writeFile(file, content);}
async function fixture({legacy = true, additional = []} = {}) {
  const base = await mkdtemp(join(tmpdir(), 'matrix-customer-packaging-')); fixtures.push(base);
  const inputs = join(base, 'fresh runtime dependencies'), output = join(base, 'customer output');
  for (const [source, , platform] of [...platforms, ...additional]) {
    const folder = join(inputs, source), windows = platform.startsWith('windows');
    await put(join(folder, 'runtime/node', windows ? 'node.exe' : 'bin/node'));
    await put(join(folder, 'runtime/node/LICENSE'), 'fixture license');
    await put(join(folder, 'runtime/node/VERSION'), 'v24.21.0\n');
    await put(join(folder, 'runtime/node/include/node/unneeded.h'));
    for (const dependency of ['playwright-core', 'ws']) {
      await put(join(folder, 'node_modules', dependency, 'package.json'), JSON.stringify({name: dependency, version: '1.0.0'}));
      await put(join(folder, 'node_modules', dependency, 'index.js'), 'export default {};');
    }
    if (legacy) {
      await put(join(folder, 'local-connector/connector.mjs'));
      await put(join(folder, 'package.json'), '{}'); await put(join(folder, 'README.md'));
      await put(join(folder, windows ? 'START-CONNECTOR.bat' : '启动连接器.command'));
      await put(join(folder, windows ? 'PAIR-CONNECTOR.bat' : 'PAIR-CONNECTOR.command'));
    }
    // A prior delivery folder must never become a way to ship user state.
    await put(join(folder, '.env'), 'fixture-secret-do-not-package');
    await put(join(folder, 'cloud-device.json'), '{"deviceToken":"fixture-secret-do-not-package"}');
    await put(join(folder, 'unrelated-development-tool.mjs'));
  }
  return {base, inputs, output};
}
const build = (f, args = [], options = {}) => run(python, ['-X', 'utf8', f.builder || builder, '--runtime-root', f.inputs, '--output-dir', f.output, '--cloud-url', 'https://customer.test', ...args], options);
async function moduleFixture(f) {
  const source = join(f.base, 'clean source'); f.builder = join(source, 'scripts/build-connector-packages.py');
  await put(f.builder, await readFile(builder));
  const modules = {
    'local-connector/launch.mjs': "import './connector.mjs';",
    'local-connector/connector.mjs': "export {value} from '../shared/root.mjs';",
    'local-connector/pair.mjs': "import './connector.mjs';",
    'shared/root.mjs': "export {value} from './leaf.mjs';",
    'shared/leaf.mjs': 'export const value = 42;',
    'local-connector/sync-worker.mjs': "import '../scripts/xhs-client.mjs';",
    'scripts/xhs-client.mjs': "await import('./customer-helper.mjs');",
    'scripts/customer-helper.mjs': "export {value} from '../shared/leaf.mjs';",
    'scripts/studio-executor.mjs': "import './runtime-path.mjs';",
    'scripts/runtime-path.mjs': 'export const root = new URL("../", import.meta.url);',
    'scripts/development-only.mjs': "import '../private/key.json';",
  };
  for (const [name, content] of Object.entries(modules)) await put(join(source, name), content);
  return source;
}
async function inspect(f, filename) {
  const script = `import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n names=z.namelist()\n root=names[0].split('/')[0]+'/'\n manifest=json.loads(z.read(root+'MANIFEST.json'))\n metadata=json.loads(z.read(root+'runtime/node/runtime-metadata.json')) if root+'runtime/node/runtime-metadata.json' in names else None\n print(json.dumps({'names':names,'modes':{i.filename:oct((i.external_attr>>16)&0o777) for i in z.infolist()},'manifest':manifest,'metadata':metadata,'readme':z.read(root+'README.md').decode(),'package':json.loads(z.read(root+'package.json'))}))`;
  return JSON.parse((await run(python, ['-c', script, join(f.output, filename)])).stdout);
}
afterEach(async () => {
  for (const base of fixtures.splice(0)) {
    if (!resolve(base).startsWith(resolve(tmpdir()) + sep)) throw Error('Unsafe fixture cleanup');
    await rm(base, {recursive: true, force: true});
  }
});

it('ships the sync and draft module dependencies inside every customer ZIP', async () => {
  const f = await fixture(); await build(f, ['--allow-unsigned']);
  for (const [source, filename] of platforms) {
    const zip = await inspect(f, filename);
    expect(zip.names).toContain(source + '/scripts/runtime-path.mjs');
    expect(zip.names).toContain(source + '/local-connector/sync-worker.mjs');
    expect(zip.names).toContain(source + '/local-connector/pair.mjs');
    expect(zip.names).toContain(source + '/scripts/studio-executor.mjs');
    expect(zip.names).not.toContain(source + '/scripts/xhs-qr-login.mjs');
    expect(zip.names).not.toContain(source + '/scripts/browser-bridge-path.mjs');
    if (source.startsWith('mac-')) {
      expect(zip.modes[source + '/runtime/node/bin/node']).toBe('0o755');
      expect(zip.modes[source + '/启动连接器.command']).toBe('0o755');
      expect(zip.manifest.candidate).toBe(true);
      expect(zip.manifest.runtime.signed).toBeNull();
      expect(zip.manifest.runtime.signatureVerification).toBe('not-verified');
    }
  }
});

it('includes only runtime, dependency and customer code allowlists from a prior folder', async () => {
  const f = await fixture(); await build(f, ['--allow-unsigned']);
  const zip = await inspect(f, platforms[0][1]);
  expect(zip.names.some(name => /\.env$|cloud-device|unrelated-development-tool|unneeded\.h/.test(name))).toBe(false);
});

it('builds Windows alone from fresh runtime and dependency folders', async () => {
  const f = await fixture({legacy: false});
  await build(f, ['--platform', 'windows']);
  const zip = await inspect(f, platforms[0][1]);
  expect(zip.names).toContain('windows-connector/START-CONNECTOR.bat');
  expect(zip.names).toContain('windows-connector/PAIR-CONNECTOR.bat');
  expect(zip.package.type).toBe('module');
  expect(zip.manifest.runtime.nodeVersion).toBe('24.21.0');
  expect(zip.readme).toContain('自行注册');
});

it('never bypasses the Mac signature gate when no runtime override was supplied', async () => {
  const f = await fixture();
  let failure; try {await build(f, [], {env: {...process.env, PATH: '', Path: ''}});} catch (error) {failure = error;}
  expect(failure).toBeTruthy();
  expect(failure.stderr).toContain('codesign');
});

it('records the runtime version from its metadata rather than a hardcoded default', async () => {
  const f = await fixture(); await build(f, ['--node-runtime-root', f.inputs, '--allow-unsigned']);
  const zip = await inspect(f, platforms[0][1]);
  expect(zip.manifest.runtime.nodeVersion).toBe('24.21.0');
});

it.each([
  ['windows-connector-arm64', 'matrix-cloud-windows-arm64-connector.zip', 'windows-arm64'],
  ['windows-connector-x86', 'matrix-cloud-windows-x86-connector.zip', 'windows-x86'],
  ['linux-connector-x64', 'matrix-cloud-linux-x64-connector.zip', 'linux-x64'],
  ['linux-connector-arm64', 'matrix-cloud-linux-arm64-connector.zip', 'linux-arm64'],
])('builds a separate %s archive with the platform runtime and usable launch permissions', async (source, filename, platform) => {
  const f = await fixture({legacy: false, additional: [[source, filename, platform]]});
  await build(f, ['--platform', platform]);
  const zip = await inspect(f, filename), windows = platform.startsWith('windows');
  expect(zip.manifest.platform).toBe(platform);
  expect(zip.manifest.candidate).toBe(true);
  expect(zip.names).toContain(source + '/runtime/node/' + (windows ? 'node.exe' : 'bin/node'));
  if (!windows) {
    expect(zip.modes[source + '/runtime/node/bin/node']).toBe('0o755');
    expect(zip.modes[source + '/START-CONNECTOR.sh']).toBe('0o755');
    expect(zip.modes[source + '/PAIR-CONNECTOR.sh']).toBe('0o755');
  }
});

it('follows export and literal dynamic imports through customer modules without bundling development entries', async () => {
  const f = await fixture(); await moduleFixture(f); await build(f, ['--allow-unsigned']);
  const zip = await inspect(f, platforms[0][1]);
  expect(zip.names).toContain('windows-connector/scripts/customer-helper.mjs');
  expect(zip.names).toContain('windows-connector/shared/leaf.mjs');
  expect(zip.names).not.toContain('windows-connector/scripts/development-only.mjs');
});

it('rejects a missing transitive customer module before producing a ZIP', async () => {
  const f = await fixture(), source = await moduleFixture(f);
  await rm(join(source, 'scripts/customer-helper.mjs'));
  let failure; try {await build(f, ['--allow-unsigned']);} catch (error) {failure = error;}
  expect(failure?.stderr).toContain('客户模块导入缺失：scripts/customer-helper.mjs');
});

it('rejects contradictory runtime version metadata', async () => {
  const f = await fixture();
  await put(join(f.inputs, 'windows-connector/runtime/node/runtime-metadata.json'), '{"nodeVersion":"22.14.0"}');
  let failure; try {await build(f, ['--platform', 'windows']);} catch (error) {failure = error;}
  expect(failure?.stderr).toContain('版本元数据');
});

it('rejects a runtime with no version evidence instead of inventing a default', async () => {
  const f = await fixture(); await rm(join(f.inputs, 'windows-connector/runtime/node/VERSION'));
  let failure; try {await build(f, ['--platform', 'windows']);} catch (error) {failure = error;}
  expect(failure?.stderr).toContain('版本元数据');
});

it('copies only public runtime evidence fields rather than credentials hidden in a metadata file', async () => {
  const f = await fixture();
  await put(join(f.inputs, 'windows-connector/runtime/node/runtime-metadata.json'), '{"version":"24.21.0","archive":"node-fixture.zip","deviceToken":"fixture-secret-do-not-package"}');
  await build(f, ['--platform', 'windows']);
  const zip = await inspect(f, platforms[0][1]);
  expect(zip.metadata).toEqual({version: '24.21.0', archive: 'node-fixture.zip'});
});

it.skipIf(process.platform !== 'win32')('runs the packaged Windows recovery entry without interpreting hostile device input as batch commands', async () => {
  const f = await fixture(); await build(f, ['--platform', 'windows']);
  const extracted = join(f.base, '隔离 pairing runtime');
  await run(python, ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', join(f.output, platforms[0][1]), extracted]);
  const folder = join(extracted, 'windows-connector'), binary = join(folder, 'runtime/node/node.exe'), calls = join(f.base, 'pairing-arguments.json'), marker = join(f.base, 'injection-marker');
  await rm(binary); await link(process.execPath, binary);
  await writeFile(join(folder, 'local-connector/connector.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.MATRIX_PAIR_TEST_CALL, JSON.stringify(process.argv.slice(2)));`);
  const deviceName = `device" & echo injected>"${marker}" & rem "`;
  const child = spawn('cmd.exe', ['/d', '/c', 'PAIR-CONNECTOR.bat'], {cwd: folder, env: {...process.env, MATRIX_PAIR_TEST_CALL: calls}, stdio: ['pipe', 'pipe', 'pipe'], shell: false});
  let stderr = ''; child.stdout.resume(); child.stderr.setEncoding('utf8'); child.stderr.on('data', data => {stderr += data;});
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {child.kill(); reject(Error('packaged recovery timeout'));}, 10000);
    child.once('error', error => {clearTimeout(timer); reject(error);}); child.once('close', value => {clearTimeout(timer); resolve(value);});
    child.stdin.on('error', () => {}); child.stdin.end('12345678\n' + deviceName + '\n');
  });
  await expect(access(marker)).rejects.toThrow();
  expect(code, stderr).toBe(0);
  expect(JSON.parse(await readFile(calls, 'utf8'))).toEqual(['--cloud-url', 'https://customer.test', '--pairing-code', '12345678', '--device-name', deviceName]);
});
