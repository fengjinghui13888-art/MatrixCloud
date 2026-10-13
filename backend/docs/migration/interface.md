# Python API, gateway and maintenance integration

`app.api.create_app(settings=None, services=None) -> FastAPI` consumes `Services(settings)`, the concrete signatures in `services-interface.md`, and the shared validators in `app.protocols`. JSON field names remain camelCase. API middleware chooses the authenticated workspace before any service call; no customer request falls back to `owner`.

`app.state.runtime` owns `.pairing`, `.channel`, `.grants`, and `.workspace(name) -> (Scope, WorkspaceExecution, EventSync)`. `.model_transport` optionally supplies an async `(url, headers, body) -> JSON` transport for synthetic tests. Production defaults to the SSRF guarded provider transport in `models.py`, with no fabricated provider results and no automatic retry of billed calls.

Each generation/resume request captures one deep copied model/provider/key configuration and one reference-image snapshot before dispatch. All text and image calls in that request use the captured configuration even if the active profile changes. A later explicit resume captures the configuration selected for that new request.

## HTTP and authentication

- Cookie: `zhixu_session`; HttpOnly, Strict, `/api`, eight hours; Secure for configured HTTPS origins. Browser writes require the configured Origin and JSON authentication requests.
- Service bearer: the provisioned service token selects owner; ordinary customer cookies select their own workspace. MCP HTTP requires the service bearer, matching the original grey application.
- Trusted proxy IPs are explicit. `trust_loopback_proxy` permits the explicitly trusted local HTTPS ingress. Local HTTP proxy trust requires development mode, a loopback HTTP public origin, exact Host and exact `X-Forwarded-Proto: http`. Trusted forwarding preserves the outside client IP for rate limits, setup protection and upgrade holds.
- Tenant roles, media ownership, path validation, provider SSRF validation, terminal receipt immutability, optimistic task revisions and original disabled legacy execution responses are preserved.

All 126 source registrations (118 unique method/path pairs) have real Python handlers. The additional computed template publication routes, connector relay, WebSocket and native MCP/OAuth paths are enumerated in `api-coverage.json`. Registration verification is separate from individual behavior and real platform acceptance; the ledger does not treat a registered endpoint as a real account workflow proof.

## Device and execution channel

`Pairing(Path)` retains `connector-pairing.sqlite` tables and eight digit, single use, five minute pairing codes. `PostgresPairing(services.db)` uses normalized `device`, `device_pairing`, `device_binding`, `device_selection`, `device_run`, `connector_limit` tables. No PostgreSQL deployment opens a substitute SQLite device registry.

`ConnectorChannel` provides synchronous `binding(workspace,profile)`, `selected(workspace)`, `select(workspace,device)`, `authorize(...)`, and async `online`, `browser_device`, `bind`, `request`, `json`, `close`, `watch`, `websocket`. `request` returns `{status,contentType,data:bytes}`. Omitting body differs from JSON null or `{}`. Browser device choice counts offline devices and never silently switches computers. New login/sync/draft commands require protocol 4 plus device-queue, stop-ack, passive-state and paced-actions.

WS endpoint `/api/connector/channel` authenticates device bearer tokens and rechecks revocation/tenant activation. Request/head/chunk/end/error and event/watch/event-ack framing matches `connector-interface.md`. Events are ordered separately from command responses; persisted events are ACKed before automatic drains. Revocation, replacement, invalid frames and disconnection never report an unconfirmed task as successful.

`ExecutionGrants.issue(workspace,task_id,account_id,profile,device_id,run_id,validate)` creates a 15 minute bearer. Studio grants can read only the specified task/media and account overview, and submit only claim/progress/receipt. Sync grants are run scoped. Identity binding and device revocation remain part of grant validation.

`WorkspaceExecution` ports local-login JSON history, sync JSON history and the existing global `browser-runs.sqlite` mutex. Login writes an account only after both platform identities agree; rescans use a fresh profile, and late callbacks cannot overwrite a removed/rebound account. Unknown stops retain the lease. Sync uses protocol-4 customer device collection, hashes framed media before archiving, preserves original five-segment account/note media paths, and only imports still-bound account snapshots. PostgreSQL sync jobs use normalized `job` and `job_attempt`, a 19 minute lease, and immutable terminal state.

`EventSync` persists `event-sync.json`, deduplicates recent event IDs, merges hints by kind, binds them to the original workspace/device/profile/handle, pauses unknown/blocked/restarted work, and reconciles authoritative success without relaunch. A confirmed studio/sync lease release wakes only persisted pending hints. No event means no new sync.

## Native MCP and maintenance

`app.mcp_server.run_stdio(settings=None,workspace='owner',legacy=False)` runs the installed Python MCP SDK through its actual stdio transport. `legacy=True` runs the original WorkBuddy overview/create/list tools. `/mcp` exposes the eight grey business tools; `/mcp/workbuddy` exposes the three WorkBuddy tools through native stateless Streamable HTTP without a slash redirect. Tool completions use persisted queues and require actual success evidence.

`app.maintenance.run_maintenance(settings=None,port=4176)` runs the separate loopback service from a private `maintenance_config`. Its state stays outside the source workspace and customer databases. `/authorize`, `/token`, `/revoke`, OAuth metadata, consent and release review forms implement registered callbacks, PKCE S256, single use codes/refresh tokens, scoped access and family revocation. Human forms require Origin, a short lived cookie nonce, rate limited administrator password verification, and a second review bound to the exact commit/image. There is no MCP approval tool.

Maintenance tools port context/read/search, isolated source changes with expected file hashes, fixed isolated checks, job status and hash guarded cleanup. Source paths exclude data, secrets, runtime DBs and symlink/junction traversal. Checks require an administrator registered immutable container and dependency hash, no network and no production credentials. Missing configuration returns explicit 503; inaccessible database/provider/device returns an actual failure.

The original single-container prepare/deploy/rollback path remains explicitly blocked for the separated version. It cannot publish one backend image as the whole system. Publication requires an independently reviewed dual-container process and precise frontend/backend image evidence followed by human confirmation. No deployment was executed during migration.

## Verification limits

The API test files cover registration, cookie workspace isolation, CSRF, task request deduplication, protocol framing/revocation, offline selection, scoped grants, per-image persistence/resume, terminal sync receipts, event restart recovery, native HTTP MCP, OAuth/PKCE/replay/revocation, role filtered maintenance tools, protected source paths and proxy security. Tests use synthetic temporary stores, synthetic provider transports and in-process sockets only. Live PostgreSQL, Docker isolated checks, real Windows/Mac browsers/accounts, provider billing and production publication remain separate acceptance items.
