# Portable handoff and Windows migration

Baseline: 948185b on codex/customer-reliability

Tasks:
1. Lock runtime metadata and add cross-platform preflight/path tests.
2. Replace external sqlite3 CLI with a portable SQLite adapter.
3. Fix Windows process launch, supervisor, PowerShell and connector configuration.
4. Add WSL2/Docker development compose and release packaging with manifests.
5. Add handoff, development, architecture, operations and release documentation.
6. Run focused and full validation, package a sanitized release bundle, and record results.

Constraints: preserve image/text provider settings, costs, materials, wash/variation, and 1–12 image creation behavior. Never package production credentials, browser profiles or customer data. Windows target is 10/11 x64; backend development uses WSL2 + Docker Desktop.
