-- Run only as the migration owner. The web application has no DDL privileges.
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migration(version integer PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS tenant(tenant_id text PRIMARY KEY,name text NOT NULL,contact text NOT NULL DEFAULT '',enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS app_user(tenant_id text NOT NULL REFERENCES tenant,username text PRIMARY KEY,password_hash text NOT NULL,password_salt text NOT NULL DEFAULT '',display_name text NOT NULL,role text NOT NULL CHECK(role IN ('admin','operator','lead_viewer')),enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,username));
CREATE TABLE IF NOT EXISTS login_session(hash text PRIMARY KEY,tenant_id text NOT NULL,username text NOT NULL,expires bigint NOT NULL,FOREIGN KEY(tenant_id,username) REFERENCES app_user(tenant_id,username) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS login_session_expiry ON login_session(expires);
CREATE TABLE IF NOT EXISTS login_limit(key text PRIMARY KEY,bucket bigint NOT NULL,count integer NOT NULL);

CREATE TABLE IF NOT EXISTS xiaohongshu_account(tenant_id text NOT NULL REFERENCES tenant,id text NOT NULL,name text NOT NULL,handle text NOT NULL,profile text NOT NULL,avatar text NOT NULL,state text NOT NULL,followers integer NOT NULL,last_synced_at text NOT NULL,sync_interval integer NOT NULL DEFAULT 900,PRIMARY KEY(tenant_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS account_handle ON xiaohongshu_account(tenant_id,lower(handle));
CREATE TABLE IF NOT EXISTS note(tenant_id text NOT NULL,id text NOT NULL,account_id text NOT NULL,title text NOT NULL,summary text,cover text,url text,published_at text NOT NULL,metrics jsonb NOT NULL,media_type text,images jsonb,video_url text,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,account_id,id),FOREIGN KEY(tenant_id,account_id) REFERENCES xiaohongshu_account(tenant_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS note_account_time ON note(tenant_id,account_id,published_at DESC);
ALTER TABLE note ADD COLUMN IF NOT EXISTS has_video_url boolean NOT NULL DEFAULT false;
ALTER TABLE note ADD COLUMN IF NOT EXISTS has_media_assets boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS asset(tenant_id text NOT NULL,account_id text NOT NULL,note_id text NOT NULL,id text NOT NULL,kind text NOT NULL,position integer NOT NULL,source_url text NOT NULL,path text NOT NULL,bytes bigint NOT NULL,sha256 text NOT NULL,PRIMARY KEY(tenant_id,account_id,note_id,id),FOREIGN KEY(tenant_id,account_id,note_id) REFERENCES note(tenant_id,account_id,id) ON DELETE CASCADE);
ALTER TABLE asset ADD COLUMN IF NOT EXISTS ordinal integer NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS message(tenant_id text NOT NULL,id text NOT NULL,account_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('comment','direct')),note_id text,conversation_id text,author text NOT NULL,avatar text,body text NOT NULL,created_at text NOT NULL,status text,tags jsonb,direction text,PRIMARY KEY(tenant_id,account_id,kind,id),UNIQUE(tenant_id,account_id,kind,id,note_id),FOREIGN KEY(tenant_id,account_id) REFERENCES xiaohongshu_account(tenant_id,id) ON DELETE CASCADE,FOREIGN KEY(tenant_id,account_id,note_id) REFERENCES note(tenant_id,account_id,id) ON DELETE CASCADE,CHECK((kind='comment' AND note_id IS NOT NULL AND conversation_id IS NULL) OR (kind='direct' AND note_id IS NULL AND conversation_id IS NOT NULL)));
CREATE UNIQUE INDEX IF NOT EXISTS comment_identity ON message(tenant_id,id) WHERE kind='comment';
CREATE INDEX IF NOT EXISTS message_account_time ON message(tenant_id,account_id,kind,created_at DESC);
CREATE TABLE IF NOT EXISTS clue(tenant_id text NOT NULL,id text NOT NULL,account_id text NOT NULL,source_note_id text NOT NULL,source_comment_id text NOT NULL,source_kind text NOT NULL DEFAULT 'comment' CHECK(source_kind='comment'),level text NOT NULL,status text NOT NULL,owner_id text,created_at text NOT NULL,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,source_comment_id),FOREIGN KEY(tenant_id,account_id,source_kind,source_comment_id,source_note_id) REFERENCES message(tenant_id,account_id,kind,id,note_id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS clue_account_time ON clue(tenant_id,account_id,created_at DESC);
CREATE TABLE IF NOT EXISTS follow_up(tenant_id text NOT NULL,id text NOT NULL,lead_id text NOT NULL,body text NOT NULL,author text NOT NULL,created_at text NOT NULL,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,lead_id) REFERENCES clue(tenant_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS team_member(tenant_id text NOT NULL REFERENCES tenant,id text NOT NULL,name text NOT NULL,role text NOT NULL,avatar text NOT NULL,PRIMARY KEY(tenant_id,id));
CREATE TABLE IF NOT EXISTS sync_run(tenant_id text NOT NULL REFERENCES tenant,id text NOT NULL,account_id text NOT NULL,status text NOT NULL,message text NOT NULL,created_at text NOT NULL,count integer,PRIMARY KEY(tenant_id,id));

CREATE TABLE IF NOT EXISTS model_config(tenant_id text NOT NULL REFERENCES tenant,id text NOT NULL,label text NOT NULL,active boolean NOT NULL DEFAULT false,ciphertext text NOT NULL,timeout_ms integer NOT NULL DEFAULT 120000,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS model_active ON model_config(tenant_id) WHERE active;
-- One task per row; revision and status participate in atomic claims, never whole-workspace JSON.
CREATE TABLE IF NOT EXISTS generation(tenant_id text NOT NULL REFERENCES tenant,id text NOT NULL,request_id text NOT NULL,account_id text,kind text NOT NULL CHECK(kind IN ('studio','creation','publish')),revision integer NOT NULL DEFAULT 1,status text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,kind,request_id));
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='generation_account_fk') THEN ALTER TABLE generation ADD CONSTRAINT generation_account_fk FOREIGN KEY(tenant_id,account_id) REFERENCES xiaohongshu_account(tenant_id,id) ON DELETE CASCADE; END IF; END $$;
CREATE INDEX IF NOT EXISTS generation_account_status ON generation(tenant_id,account_id,status,created_at DESC);
CREATE TABLE IF NOT EXISTS template(tenant_id text NOT NULL REFERENCES tenant,id text NOT NULL,fingerprint text NOT NULL,revision integer NOT NULL,payload jsonb NOT NULL,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,fingerprint));
CREATE TABLE IF NOT EXISTS job(tenant_id text NOT NULL REFERENCES tenant,id text NOT NULL,account_id text,kind text NOT NULL,status text NOT NULL,lease_until timestamptz,attempt integer NOT NULL DEFAULT 1,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id));
CREATE UNIQUE INDEX IF NOT EXISTS active_account_job ON job(tenant_id,account_id,kind) WHERE status='running';
CREATE INDEX IF NOT EXISTS job_status ON job(tenant_id,status,lease_until);
CREATE TABLE IF NOT EXISTS job_attempt(tenant_id text NOT NULL,job_id text NOT NULL,attempt integer NOT NULL,started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,result text,PRIMARY KEY(tenant_id,job_id,attempt),FOREIGN KEY(tenant_id,job_id) REFERENCES job(tenant_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS device(tenant_id text NOT NULL REFERENCES tenant,id text NOT NULL,name text NOT NULL,platform text NOT NULL,version text NOT NULL,token_hash text UNIQUE NOT NULL,created_at text NOT NULL,last_seen_at bigint NOT NULL,revoked_at bigint,PRIMARY KEY(tenant_id,id));
CREATE TABLE IF NOT EXISTS device_pairing(tenant_id text NOT NULL REFERENCES tenant,id text NOT NULL,code_hash text UNIQUE NOT NULL,expires_at bigint NOT NULL,status text NOT NULL,device_id text,created_at text NOT NULL,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,device_id) REFERENCES device(tenant_id,id));
CREATE TABLE IF NOT EXISTS device_binding(tenant_id text NOT NULL,profile text NOT NULL,device_id text NOT NULL,PRIMARY KEY(tenant_id,profile),FOREIGN KEY(tenant_id,device_id) REFERENCES device(tenant_id,id));
CREATE TABLE IF NOT EXISTS device_selection(tenant_id text PRIMARY KEY,device_id text NOT NULL,FOREIGN KEY(tenant_id,device_id) REFERENCES device(tenant_id,id));
CREATE TABLE IF NOT EXISTS device_run(tenant_id text NOT NULL,id text NOT NULL,device_id text NOT NULL,profile text NOT NULL,kind text NOT NULL,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,device_id) REFERENCES device(tenant_id,id));
CREATE TABLE IF NOT EXISTS connector_limit(key text PRIMARY KEY,bucket bigint NOT NULL,count integer NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(tenant_id text NOT NULL REFERENCES tenant,id bigint GENERATED ALWAYS AS IDENTITY,actor text NOT NULL,action text NOT NULL,target text NOT NULL,result text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,id));
CREATE INDEX IF NOT EXISTS audit_tenant_time ON audit_log(tenant_id,created_at DESC);
CREATE TABLE IF NOT EXISTS legacy_migration(tenant_id text PRIMARY KEY REFERENCES tenant,source_hash text NOT NULL,manifest jsonb NOT NULL,completed_at timestamptz NOT NULL DEFAULT now());

-- Defense in depth: business queries must also provide tenant_id predicates.
DO $$DECLARE t text;BEGIN
  FOREACH t IN ARRAY ARRAY['xiaohongshu_account','note','asset','message','clue','follow_up','team_member','sync_run','model_config','generation','template','job','job_attempt','device_binding','device_selection','device_run','audit_log','legacy_migration'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE tablename=t AND policyname='tenant_boundary') THEN
      EXECUTE format('CREATE POLICY tenant_boundary ON %I USING (tenant_id = current_setting(''app.tenant_id'',true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'',true))',t);
    END IF;
  END LOOP;
END $$;

ALTER TABLE message ADD COLUMN IF NOT EXISTS lead_dismissed boolean NOT NULL DEFAULT false;
ALTER TABLE clue ALTER COLUMN source_note_id DROP NOT NULL;
ALTER TABLE clue DROP CONSTRAINT IF EXISTS clue_source_kind_check;
ALTER TABLE clue ADD CONSTRAINT clue_source_kind_check CHECK(source_kind IN ('comment','direct'));
ALTER TABLE clue DROP CONSTRAINT IF EXISTS clue_tenant_id_source_comment_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS clue_source_identity ON clue(tenant_id,account_id,source_kind,source_comment_id);
DO $$BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='clue_message_source_fk') THEN
ALTER TABLE clue ADD CONSTRAINT clue_message_source_fk FOREIGN KEY(tenant_id,account_id,source_kind,source_comment_id) REFERENCES message(tenant_id,account_id,kind,id) ON DELETE CASCADE;
END IF;
END $$;
INSERT INTO schema_migration(version) VALUES(3) ON CONFLICT DO NOTHING;

INSERT INTO schema_migration(version) VALUES(2) ON CONFLICT DO NOTHING;
COMMIT;
