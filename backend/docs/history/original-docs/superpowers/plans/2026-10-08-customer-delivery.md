# Customer Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce reviewable customer delivery candidates with self registration, isolated workspaces and portable connector packages.

**Architecture:** Retain the existing hosted React/Express/PostgreSQL workbench and paired local connector. Repair public registration boundaries and package completeness, then build independently verified platform artifacts. Keep pending platform candidates separate from published downloads.

**Tech Stack:** React18, TypeScript, Node22.14, PostgreSQL16, Python zipfile, Vitest.

**Spec:** docs/superpowers/specs/2026-10-08-customer-delivery.md

## Global Constraints

- Public registration creates an independent UUID workspace; only protected local setup creates owner.
- New credentials: at least12 characters and at most72 UTF-8 bytes; retain existing login compatibility.
- Keep current user data, credentials, supplier settings and budgets intact.
- Official Node22.14.0 artifacts require SHA256 verification before extraction/use.
- Never include .handoff, private keys, cloud-device.json, profiles or customer data in customer artifacts.
- Windows x64 actual verification; other platforms explicitly pending. Mac production signature checks cannot be bypassed.
- Production deployment requires functioning authenticated maintenance access, currently unavailable.

## Review Focus

- Public registration on a fresh installation must not expose owner records.
- Concurrent clients must not create duplicate names or share workspace identifiers.
- Multibyte passwords and network timeout must receive actionable UI errors.
- Missing transitive relative imports must fail package construction rather than customer tasks.
- Untracked fixes and false runtime/signature metadata must not disappear from delivery evidence.

### Task1: Registration and login correctness

Files: server/account-auth.ts, server/tenant-auth.ts, src/AccountLogin.tsx and authentication tests, server/__tests__/postgres-integration.test.ts.

Interfaces: unchanged /api/auth/setup, /register, /login; public register returns independent workspace and normal session.

- [ ] Write and observe failing tests for first public customer isolation, concurrent registration, duplicate name, cross-client login, UTF-8 rule and request timeout.
- [ ] Implement UUID-only public registration, consistent new credential validation and abortable UI requests.
- [ ] Verify isolated real PostgreSQL integration and focused SQLite/UI tests. Update old fixtures to use explicit owner setup where necessary.

### Task2: Portable customer packages

Files: scripts/build-connector-packages.py and server/__tests__/connector-packaging.test.js.

Interfaces: existing --runtime-root, --node-runtime-root, --cloud-url; add repeatable --platform. Preserve original three filenames; seven ids and filenames shared with download registry.

- [ ] Write and observe failing ZIP tests for missing runtime-path.mjs, transitive relative imports, sensitive base files, executable permissions, unknown runtime metadata and Mac check bypass.
- [ ] Build from allowlisted runtime/dependencies and complete connector import closure; generate maintained launchers and self registration README.
- [ ] Verify ZIP hashes and contents; build Windows x64 formal artifact and keep unverified architectures/Mac candidates separately.

### Task3: Downloads and maintenance release

Files: shared/connector-platforms.mjs, server/connector-downloads.ts, scripts/build-release.mjs and their tests.

Interfaces: CONNECTOR_PLATFORMS records id,label,filename,source; download lists files present in published directory only. Build-release takes --cloud-url/--connector-dir/--output and captures complete source with git base+dirty state.

- [ ] Write and observe failing tests for architecture-specific download selection, credential-bearing URL, untracked repair omission and ignored credential exclusion.
- [ ] Add platform catalog and strict URL handling; copy source from explicit source directories/extensions, record hashes and dirty status, require explicit archive outcome.
- [ ] Verify release fixture and build actual reviewed maintenance handoff with only eligible published customer packages.

### Task4: Delivery verification and customer instructions

Files: docs/customer-delivery.md, outputs/customer-delivery-20261008/verification.json and customer README artifacts.

- [ ] Extract only hash-verified runtimes, record architecture headers/version and dependency evidence.
- [ ] Run full suite with real isolated PostgreSQL, TypeScript/Vite build and preflight.
- [ ] Extract Windows x64 customer ZIP into Chinese/spaced path and verify bundled runtime/module imports and isolated connector HTTP startup without host Node dependencies or real XHS actions.
- [ ] Obtain independent review and repair material findings. Publish finite support matrix, exact artifacts and pending cloud/Mac/platform checks.

Execution proceeds under the user's explicit autonomous instruction. Preserve the existing uncommitted development work; do not create commits, move profiles or claim inaccessible deployment succeeded.
