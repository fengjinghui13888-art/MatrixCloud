# Python Backend Migration Implementation Plan

> **For agentic workers:** Execute independent domains using superpowers:dispatching-parallel-agents and integrate with compatibility tests. No duplicate full-repository reads.

**Goal:** All backend and client execution implementations use Python; only frontend/backend remain visible at root.
**Architecture:** React frontend standalone; Python FastAPI services, Python connector, Python MCP and existing DB-compatible storage. Shared protocols become Python code and frontend-only contracts.
**Tech Stack:** Python 3.13, FastAPI, Uvicorn, psycopg, Playwright, MCP, pytest; existing React/Vite versions.
**Spec:** python-design.md

## Global Constraints

- Preserve original sources, all live data, credentials, media and browser profiles.
- Preserve provider/price settings, Chinese UI text, image defaults and 1–12 range.
- No production action or real platform run during migration.
- No Node backend bridge or placeholder success responses.
- Keep Git metadata hidden; only frontend and backend visible at root.

## Review Focus

- Existing encrypted profiles and legacy account hashes remain readable.
- Every request remains bound to its authenticated workspace and chosen device.
- Unknown or interrupted upload/save results never trigger repeated upload.
- Different startup CWDs resolve configuration, data and frontend commands correctly.
- Database and runtime files stay out of source commits and delivery archives.

### Task 1: Persistence, auth and business services

Files: backend/app/{services,store,auth,queues,studio,templates,models,billing,postgres}.py and backend/tests/test_services*.py.

- [x] Port original SQLite formats and normalized PG tables.
- [x] Preserve auth cookies, password formats, roles and origin checks.
- [x] Port creation/publish/studio transitions, model encryption/SSRF, templates and media.
- [x] Test persistence, duplicate requests, isolation, encryption compatibility and cancellation.
- [x] Publish the complete Services/Scope API signatures for API integration.

### Task 2: Pure Python local connector and execution

Files: backend/connector/**/*.py, backend/app/protocols.py and backend/tests/test_connector*.py.

- [x] Port shared protocol validation first.
- [x] Port loopback HTTP, secure pairing, cloud WS, revocation, replay/ACK and device queue.
- [x] Port CDP browser identity, synchronization, media capture, QR login and guarded draft execution.
- [x] Port required JS execution tools into Python entrypoints; keep browser expressions embedded as strings only.
- [x] Test fail-closed behavior, cancellation, ownership and result-unknown protection without real accounts.

### Task 3: FastAPI endpoints, MCP and maintenance

Files: backend/app/{api,gateway,sync,event_sync,mcp_server,maintenance}.py and backend/tests/test_api*.py.

- [x] Map all original API routes to the Services/Scope interface.
- [x] Port HTTP authorization, device-scoped WS, sync jobs, event subscriptions and connector transport.
- [x] Port MCP stdio/HTTP tools and maintenance auth/read/check/approval safeguards.
- [x] Test API compatibility, CSRF, token revocation, workspace isolation, media, tasks and MCP.
- [x] Produce route-coverage evidence against original-api-contracts.json.

### Task 4: Standalone frontend and final structure

Files: frontend/{package,pnpm-lock,tsconfig,vite.config,vitest.config}.json/ts; frontend/src/contracts; backend/{run.py,requirements.txt,Dockerfile,START-*.bat}; backend/docs.

- [x] Move frontend contracts into frontend and preserve standalone locked dependency versions.
- [x] Implement settings and CLI startup from arbitrary CWDs with tests.
- [x] Move data/docs/tools/config into backend and retire Node source to the external recovery copy.
- [x] Check the visible root has exactly frontend and backend.
- [x] Run the complete Python and frontend suites, actual local startup/proxy/MCP checks and independent final review.
- [x] Save validation limits and updated delivery sources; keep previous version recoverable.
