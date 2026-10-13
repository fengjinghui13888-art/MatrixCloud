// Avoid OS argv length limits without spawning a CLI for every image chunk.
import {pathToFileURL} from 'node:url';
let input='';
for await(const chunk of process.stdin)input+=chunk;
const {cli,args}=JSON.parse(input);
process.argv=[process.execPath,cli,...args];
await import(pathToFileURL(cli).href);
