// @vitest-environment node
import {afterEach, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import {access, cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';

const fixtures = [], project = resolve('.');
async function fixture(cloudUrl = 'https://customer.test') {
  const root = await mkdtemp(join(tmpdir(), 'matrix-pair-recovery-')); fixtures.push(root);
  await mkdir(join(root, 'local-connector'));
  await cp(join(project, 'local-connector/pair.mjs'), join(root, 'local-connector/pair.mjs')).catch(error => {if (error.code !== 'ENOENT') throw error;});
  await cp(join(project, 'local-connector/cloud-client.mjs'), join(root, 'local-connector/cloud-client.mjs'));
  await writeFile(join(root, 'connector-config.json'), JSON.stringify({cloudUrl}));
  await writeFile(join(root, 'local-connector/connector.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.MATRIX_PAIR_TEST_CALL, JSON.stringify(process.argv.slice(2))); process.exitCode=Number(process.env.MATRIX_PAIR_TEST_EXIT || 0);`);
  return {root, calls: join(root, 'connector-arguments.json'), marker: join(root, 'injection-marker')};
}
async function launch(f, input, exit = 0) {
  const child = spawn(process.execPath, [join(f.root, 'local-connector/pair.mjs')], {cwd: f.root, env: {...process.env, MATRIX_PAIR_TEST_CALL: f.calls, MATRIX_PAIR_TEST_EXIT: String(exit)}, stdio: ['pipe', 'pipe', 'pipe'], shell: false});
  let stdout = '', stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => {stdout += data;}); child.stderr.on('data', data => {stderr += data;});
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {child.kill(); reject(Error('pair recovery timeout'));}, 10000);
    child.once('error', error => {clearTimeout(timer); reject(error);}); child.once('close', value => {clearTimeout(timer); resolve(value);});
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
  return {code, stdout, stderr};
}
afterEach(async () => {
  for (const root of fixtures.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw Error('Unsafe fixture cleanup');
    await rm(root, {recursive: true, force: true});
  }
});

it('passes quotes and command characters as a device name without executing them', async () => {
  const f = await fixture(), name = process.platform === 'win32' ? `device" & echo injected>"${f.marker}" & rem "` : `device"; touch "${f.marker}"; #`;
  const result = await launch(f, '12345678\n' + name + '\n');
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(await readFile(f.calls, 'utf8'))).toEqual(['--cloud-url', 'https://customer.test', '--pairing-code', '12345678', '--device-name', name]);
  await expect(access(f.marker)).rejects.toThrow();
});

it('uses this computer name when the device name is left blank', async () => {
  const f = await fixture(), result = await launch(f, '12345678\n\n');
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(await readFile(f.calls, 'utf8')).at(-1)).toBe(hostname());
});

it('rejects an invalid pairing code before starting the connector', async () => {
  const f = await fixture(), result = await launch(f, '12345678" & echo injected\nignored\n');
  expect(result.code).toBe(1); expect(result.stderr).toContain('8 位数字');
  await expect(access(f.calls)).rejects.toThrow();
});

it.each(['http://127.0.0.1', 'https://user:password@customer.test'])('rejects the non-delivery configuration %s before starting a connector', async cloudUrl => {
  const f = await fixture(cloudUrl), result = await launch(f, '12345678\nname\n');
  expect(result.code).toBe(1); expect(result.stderr).toContain('HTTPS');
  await expect(access(f.calls)).rejects.toThrow();
});

it('returns the connector child exit status to the recovery launcher', async () => {
  const f = await fixture(), result = await launch(f, '12345678\nname\n', 7);
  expect(result.code, result.stderr).toBe(7);
});
