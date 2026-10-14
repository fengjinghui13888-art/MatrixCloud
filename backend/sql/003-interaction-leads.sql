-- Migration owner only. Preserve all comments, leads and follow-up records.
BEGIN;
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
COMMIT;
