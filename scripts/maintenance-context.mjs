#!/usr/bin/env node
// Read-only, bounded project context. No model, network, or customer data access.
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('..',import.meta.url));
const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:256*1024}).trim();
const modules={
  creation:{source:['frontend/src/OneClickPublish.tsx','frontend/src/PublishCenter.tsx','backend/server/studio-routes.ts'],tests:['frontend/src/__tests__/studio-ui.test.tsx','frontend/src/__tests__/publish-center-flow.test.tsx','backend/server/__tests__/studio.test.ts']},
  execution:{source:['backend/server/studio-execution.ts','backend/server/browser-runs.ts','local-connector/studio-jobs.mjs'],tests:['backend/server/__tests__/studio-execution.test.ts','backend/server/__tests__/execution-protection.test.js']},
  maintenance:{source:['backend/server/maintenance-service.ts','backend/server/maintenance-runner.ts'],tests:['backend/server/__tests__/maintenance.test.ts','backend/server/__tests__/maintenance-http.test.ts']},
};
const selected=process.argv[2];
if(selected&&!Object.hasOwn(modules,selected))throw Error('模块可选：creation / execution / maintenance');
const status=git('status','--short').split('\n').filter(Boolean);
console.log(JSON.stringify({
  revision:git('rev-parse','--short','HEAD'),branch:git('branch','--show-current'),
  changes:status.slice(0,30),omittedChanges:Math.max(0,status.length-30),
  diff:git('diff','HEAD','--stat').slice(0,1800),
  modules:selected?{[selected]:modules[selected]}:modules,
  handoff:'docs/verification/2026-09-20/customer-startup-and-cleanup.md',
  boundaries:'降本仅针对Codex开发维护。保留原生图、文案设置、素材二创与素材库；支持单任务12张。',
},null,2));
