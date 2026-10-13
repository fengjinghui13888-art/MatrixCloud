# PostgreSQL migration implementation plan

> Execute inline with superpowers:executing-plans. User authorized the migration and strict frontend/backend separation.

**Goal:** Migrate the currently running local dataset to PostgreSQL and retain independent frontend/backend startup and deployment.

**Architecture:** React calls Python through HTTP/WebSocket. Only Python receives database credentials. PostgreSQL runs as a separate local process; application startup performs no schema creation or data migration.

**Tech stack:** Existing Python 3.13, FastAPI, psycopg, PostgreSQL 16.15, React/TypeScript/Vite.

**Spec:** User request in this conversation: complete database migration, strictly separate frontend and backend. Current preview has two users and no platform records; work/grey is empty. Preserve original data, credentials, supplier configuration and prices. No remote production deployment.

## Tasks

- [x] Back up the stopped preview dataset and hash every file; install official PostgreSQL binaries under ignored backend/data/postgresql.
- [x] Add tests for refusing SQLite after cutover, database-required startup, and excluding backend secrets from frontend child processes. Implement guards and a bounded local PostgreSQL start/stop/status tool.
- [x] Create a loopback-only cluster, separate migration-owner and restricted application credentials; migrate to a new empty matrix database and verify account/session hashes and per-tenant manifests. Copy non-database runtime files into work/grey; point local .env at the application credential file.
- [x] Keep independent frontend/backend commands and build contexts, enable PostgreSQL requirement in deployment examples, and isolate the database service network. Document explicit migration and rollback.
- [x] Run relevant regressions plus isolated real PostgreSQL tests, independently start backend/frontend, verify existing login and API persistence through the browser, restart and verify persistence again. Verify the frontend bundle contains no credentials and PostgreSQL failure never falls back to SQLite.

## Review focus

1. A lost database setting after migration must fail startup instead of recreating SQLite.
2. Frontend child environment and build output must never contain backend credentials.
3. Restarts must keep database data and the original user's password/profile/session identity.
4. Migration must not overwrite a nonempty target or mix archived datasets into the active dataset.
5. Database startup must be scoped to the managed local cluster and must not stop unrelated processes.

## Execution ledger

- Initial state: clean main at 00c89fa. No installed PostgreSQL/Docker executable discovered. Official EDB Windows 16.15 distribution matches the source used in the previous independent integration tests.
- Ruling: migrate current preview into the active work/grey configuration; archived production and legacy datasets remain recovery material. This preserves current login behavior without silently restoring unrelated environments.
- Ruling: keep local connector state and file assets in backend-managed storage. Frontend/backend separation concerns process, credential, API and build boundaries; file storage is not a frontend database.
- Verification: 163 backend tests (154 ordinary + 9 isolated real PG), 96 frontend tests and build passed. Existing password, 7 UI pages, SQL readback, session refresh and backend restart persistence passed. Frontend source/dist do not contain generated DB credentials.
- Initialization required correcting Windows pg_ctl inherited-pipe waiting and the one-off verification script's login_session column name (hash). Migration committed successfully before readback; idempotent resume and direct account/session checks then completed cutover.
- Limitation: automatic approval blocked stopping the live PostgreSQL instance for an outage test. No retry. Real connection rejection and recovery verified only in an independent test fixture. Docker images and full backup restore have not been exercised.
- Post-migration pg_dump is readable and hashed. Disposable test cluster stopped successfully; automatic approval then blocked deletion of that temporary cluster and the downloaded ZIP. Both remain; no retry or alternative deletion method used.
- Independent final review found no confirmed high/medium issues. Both minor documentation findings (ALL supervision behavior and PG test count) were corrected.
