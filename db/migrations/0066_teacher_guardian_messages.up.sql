-- 0066_teacher_guardian_messages (up)
-- Why: G8. A teacher may write to a guardian directly (a person's explicit action, so Model B holds). Every message is
--   logged and the log cannot be changed or deleted by anybody through the application (no UPDATE/DELETE grant, trigger,
--   truncate guard): the owner can always see what a teacher wrote. The text itself travels as a normal outbox message,
--   so the consent and "guardian receives reminders" rules of 0004 still apply; this row ties the outbox message to the
--   teacher, the own group that made the student reachable, and the template (NULL = free text).
-- Branches: the log has no branch column; a branch session sees a row only when it can see the student (the restrictive
--   policy below is created when the branch migrations exist), so branch staff never read another branch's messages.
-- Queries the indexes serve:
--   Q-tgm-1  messages a teacher sent today (the daily limit)   -> teacher_guardian_messages_teacher_day
--   Q-tgm-2  the owner's log, newest first                     -> teacher_guardian_messages_org_recent

CREATE TABLE teacher_guardian_messages (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            BIGINT NOT NULL,
  public_id         UUID NOT NULL DEFAULT gen_random_uuid(),
  teacher_id        BIGINT NOT NULL,
  student_id        BIGINT NOT NULL,
  guardian_id       BIGINT NOT NULL,
  group_id          BIGINT NOT NULL,
  template          TEXT CHECK (template IN ('absent','late','homework','praise','meeting')),
  body              TEXT NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 4096),
  outbox_message_id BIGINT NOT NULL,
  sent_by_user_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT teacher_guardian_messages_teacher_fk  FOREIGN KEY (org_id, teacher_id)  REFERENCES teachers(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT teacher_guardian_messages_student_fk  FOREIGN KEY (org_id, student_id)  REFERENCES students(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT teacher_guardian_messages_guardian_fk FOREIGN KEY (org_id, guardian_id) REFERENCES guardians(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT teacher_guardian_messages_group_fk    FOREIGN KEY (org_id, group_id)    REFERENCES study_groups(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT teacher_guardian_messages_outbox_fk   FOREIGN KEY (org_id, outbox_message_id) REFERENCES outbox_messages(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT teacher_guardian_messages_public_id_key UNIQUE (public_id),
  CONSTRAINT teacher_guardian_messages_org_id_key UNIQUE (org_id, id),
  CONSTRAINT teacher_guardian_messages_outbox_key UNIQUE (outbox_message_id)
);
CREATE INDEX teacher_guardian_messages_teacher_day ON teacher_guardian_messages (org_id, teacher_id, created_at);
CREATE INDEX teacher_guardian_messages_org_recent ON teacher_guardian_messages (org_id, created_at DESC, id DESC);
CREATE INDEX teacher_guardian_messages_student ON teacher_guardian_messages (org_id, student_id);

CREATE TRIGGER trg_teacher_guardian_messages_no_change BEFORE UPDATE OR DELETE ON teacher_guardian_messages
  FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_teacher_guardian_messages_no_truncate BEFORE TRUNCATE ON teacher_guardian_messages
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER trg_teacher_guardian_messages_audit AFTER INSERT ON teacher_guardian_messages FOR EACH ROW EXECUTE FUNCTION audit_row();

ALTER TABLE teacher_guardian_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE teacher_guardian_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON teacher_guardian_messages FOR ALL TO nazoratly_app
  USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
GRANT SELECT, INSERT ON teacher_guardian_messages TO nazoratly_app;

DO $$ BEGIN
  IF to_regprocedure('app_branch_id()') IS NOT NULL THEN
    -- visible exactly when the student is (the students policy of 0054 does the branch work)
    EXECUTE $p$CREATE POLICY branch_scope ON teacher_guardian_messages AS RESTRICTIVE FOR ALL TO nazoratly_app
      USING (app_branch_id() IS NULL OR EXISTS (SELECT 1 FROM students s
             WHERE s.org_id = teacher_guardian_messages.org_id AND s.id = teacher_guardian_messages.student_id))
      WITH CHECK (true)$p$;
  END IF;
  IF to_regclass('branch_catalog') IS NOT NULL THEN
    INSERT INTO branch_catalog (table_name, kind, mode, ord) VALUES ('teacher_guardian_messages', 'shared', NULL, 90);
  END IF;
END $$;
