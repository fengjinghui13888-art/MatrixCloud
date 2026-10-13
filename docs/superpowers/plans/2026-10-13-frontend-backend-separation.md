# MatrixCloud Separation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan in the current session. Steps use checkbox syntax for tracking.

**Goal:** Deliver a separate working source copy with frontend/backend folders and an evidence based deletion guide.

**Architecture:** pnpm workspace, React/Vite frontend, Express API backend, root shared contracts and connector tooling. Development and production use same origin API proxying.

**Tech Stack:** Existing Node, pnpm, TypeScript, Vite, Express, Vitest and nginx.

**Spec:** ../specs/2026-10-13-frontend-backend-separation-design.md

## Global Constraints

- Source: C:/Users/huake/Desktop/MatrixCloud-Dev; output: C:/Users/huake/Desktop/MatrixCloud-Separated.
- Preserve existing working changes and originals; exclude production secrets, work data and outputs from the source copy.
- Node 22.14.0–24.x; pnpm 11.25.0; preserve resolved dependency versions.
- Preserve Chinese product copy, providers, prices, image defaults and 1–12 image range.
- No production publish or real platform account action.

## Review Focus

- Commands launched from frontend/backend must locate root tooling and shared files.
- Authentication cookies and connector WebSocket must pass through the frontend proxy.
- Release packaging must include both package manifests and all shared source.
- Legacy maintenance publication must not publish one container over the separated service pair.
- User data and original source must survive without changes.

### Task 1: Separate source, contracts and package configuration

Files: frontend/{src,index.html,vite.config.ts,tsconfig.json,package.json}; backend/{server,vitest.config.ts,tsconfig.json,package.json}; shared/{domain.ts,creation.ts}; root workspace and lock file.

- [x] Record baseline test output.
- [x] Add a backend regression test: even when a frontend index exists, GET / is 404 while GET /api/health is 200.
- [x] Run regression and observe the original backend serves index.html.
- [x] Move source into the two folders, extract shared types, update real relative import paths, remove backend static page serving.
- [x] Verify both type checks, frontend production build and regression test.

### Task 2: Adapt startup, deployment, release and maintenance

Files: scripts/start-local-dev.ps1; scripts/local-supervisor.mjs; scripts/build-release.mjs; Dockerfile; frontend/Dockerfile; frontend/nginx.conf; compose*.yaml; deploy maintenance configs; backend/server/runtime-paths.ts and maintenance*.ts.

- [x] Preserve root resolution for data, scripts and connectors.
- [x] Configure independent frontend/backend containers with API/WebSocket proxying.
- [x] Update release source roots and runtime entrypoints.
- [x] Adapt maintenance check commands and disallow legacy automatic single-container publication of this workspace.
- [x] Verify release tests, runtime API and proxy smoke checks, and available deployment configuration tools.

### Task 3: Deliver cleanup guidance and verification evidence

Files: README.md; DEVELOPMENT.md; ARCHITECTURE.md; docs/文件与代码删除指南.md; docs/file-deletion-inventory.csv; docs/verification/2026-10-13-separation.md; SOURCE-SNAPSHOT.json.

- [x] Generate every source file's role and deletion condition from actual imports, entrypoints and tooling dependencies.
- [x] Explain regenerable dependencies/build caches, historical documents, preserved operational tools and protected data.
- [x] Run the complete frontend/backend test suite and record failures or skips without claiming real account validation.
- [x] Verify original hashes, review final changes, commit separated source snapshot and open the deletion guide.
