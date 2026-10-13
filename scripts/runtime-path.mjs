import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const projectPath = (...parts) => join(projectRoot, ...parts);
export const dataPath = (...parts) => join(resolve(projectRoot, process.env.DATA_DIR ?? 'work/grey'), ...parts);
