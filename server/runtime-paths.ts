import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const moduleDirectory = import.meta.url.startsWith('file:') ? dirname(fileURLToPath(import.meta.url)) : (process.env.MATRIX_CLOUD_ROOT ?? process.cwd());
export const projectRoot = resolve(moduleDirectory, '..');
export const resolveProjectPath = (value: string) => resolve(projectRoot, value);
export const dataDir = resolveProjectPath(process.env.DATA_DIR ?? 'work');
export const greyDataDir = resolveProjectPath(process.env.SYNC_DATA_DIR ?? process.env.DATA_DIR ?? 'work/grey');
export const distDir = resolveProjectPath(process.env.DIST_DIR ?? 'dist');
export const scriptPath = (...parts: string[]) => join(projectRoot, ...parts);
