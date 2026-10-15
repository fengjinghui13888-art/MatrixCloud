BEGIN;
CREATE TABLE IF NOT EXISTS platform_admin_member(
 username text PRIMARY KEY REFERENCES app_user(username) ON DELETE CASCADE,
 permissions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(permissions)='array' AND jsonb_array_length(permissions)<=5),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_admin_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admin_member FORCE ROW LEVEL SECURITY;
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename='platform_admin_member' AND policyname='platform_owner_only') THEN
CREATE POLICY platform_owner_only ON platform_admin_member USING(current_setting('app.tenant_id',true)='owner') WITH CHECK(current_setting('app.tenant_id',true)='owner');
END IF;END $$;
INSERT INTO schema_migration(version) VALUES(4) ON CONFLICT DO NOTHING;
COMMIT;
