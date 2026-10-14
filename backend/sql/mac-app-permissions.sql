-- Run as the local PostgreSQL administrator after initialization/restoration.
-- Runtime role must never own tables or bypass row-level security.
BEGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE matrix TO matrix_app;
GRANT USAGE ON SCHEMA public TO matrix_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO matrix_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO matrix_app;
REVOKE UPDATE,DELETE ON audit_log FROM matrix_app;
REVOKE INSERT,UPDATE,DELETE ON schema_migration,legacy_migration FROM matrix_app;
COMMIT;
