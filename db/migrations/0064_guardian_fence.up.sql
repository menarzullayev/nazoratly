-- 0064_guardian_fence
-- Why: G7 guardian cabinet, the database-level fence. A guardian request runs in a tenant session whose
--   `app.guardian_id` is set (db.Session.guardian_id). A RESTRICTIVE policy `guardian_fence` ANDed with the tenant policy
--   (and the branch policy) then limits that session to the data of the students linked to the guardian, so even a
--   buggy cabinet query cannot return another family's rows. Staff and agent sessions have no guardian id: every policy
--   starts with `app_guardian_id() IS NULL` and passes them through unchanged.
--   Deny by default: every other tenant table that exists today gets `USING (app_guardian_id() IS NULL)`, i.e. a guardian
--   session sees nothing of it. A table created by a later migration decides for itself (the schema test checks the
--   tables listed here, not "all tables").
--   Whitelisted for guardians: org_settings (the center's switches), courses (names), branches (names), organizations.
-- Also here: the make-up slot candidates. The slots a guardian may choose are lessons of OTHER groups of the same course,
--   which the fence would hide, so they come from a SECURITY DEFINER function that first proves the right belongs to a
--   student linked to the calling guardian.

-- 1. rows that carry a student ---------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['enrollments','attendance','charges','payments','absence_entitlements','documents','exam_results',
                           'learning_marks','data_consents'] LOOP
    EXECUTE format($p$CREATE POLICY guardian_fence ON %I AS RESTRICTIVE FOR ALL TO nazoratly_app
      USING (app_guardian_id() IS NULL OR student_id IN (SELECT sg.student_id FROM student_guardians sg WHERE sg.guardian_id = app_guardian_id()))
      WITH CHECK (app_guardian_id() IS NULL OR student_id IN (SELECT sg.student_id FROM student_guardians sg WHERE sg.guardian_id = app_guardian_id()))$p$, t);
  END LOOP;
END $$;

-- reports and certificates: only the finished ones (an approved report, a certificate that was not voided)
CREATE POLICY guardian_fence ON progress_reports AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR (status = 'approved' AND student_id IN (SELECT sg.student_id FROM student_guardians sg WHERE sg.guardian_id = app_guardian_id())))
  WITH CHECK (app_guardian_id() IS NULL);
CREATE POLICY guardian_fence ON certificates AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR (voided_at IS NULL AND student_id IN (SELECT sg.student_id FROM student_guardians sg WHERE sg.guardian_id = app_guardian_id())))
  WITH CHECK (app_guardian_id() IS NULL);
CREATE POLICY guardian_fence ON students AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR id IN (SELECT sg.student_id FROM student_guardians sg WHERE sg.guardian_id = app_guardian_id()))
  WITH CHECK (app_guardian_id() IS NULL);
CREATE POLICY guardian_fence ON student_guardians AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR guardian_id = app_guardian_id())
  WITH CHECK (app_guardian_id() IS NULL);
CREATE POLICY guardian_fence ON guardians AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR id = app_guardian_id())
  WITH CHECK (app_guardian_id() IS NULL);

-- 2. rows reached through a group / charge / document / exam the guardian's students have ----------------------------
CREATE POLICY guardian_fence ON study_groups AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR id IN (SELECT e.group_id FROM enrollments e))
  WITH CHECK (app_guardian_id() IS NULL);
CREATE POLICY guardian_fence ON lessons AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR group_id IN (SELECT e.group_id FROM enrollments e))
  WITH CHECK (app_guardian_id() IS NULL);
CREATE POLICY guardian_fence ON group_schedules AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR group_id IN (SELECT e.group_id FROM enrollments e))
  WITH CHECK (app_guardian_id() IS NULL);
CREATE POLICY guardian_fence ON exams AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR id IN (SELECT r.exam_id FROM exam_results r))
  WITH CHECK (app_guardian_id() IS NULL);
CREATE POLICY guardian_fence ON charge_installments AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR charge_id IN (SELECT c.id FROM charges c))
  WITH CHECK (app_guardian_id() IS NULL);
CREATE POLICY guardian_fence ON payment_allocations AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR charge_id IN (SELECT c.id FROM charges c))
  WITH CHECK (app_guardian_id() IS NULL);
CREATE POLICY guardian_fence ON progress_report_files AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR report_id IN (SELECT r.id FROM progress_reports r))
  WITH CHECK (app_guardian_id() IS NULL);
CREATE POLICY guardian_fence ON certificate_files AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR certificate_id IN (SELECT c.id FROM certificates c))
  WITH CHECK (app_guardian_id() IS NULL);
CREATE POLICY guardian_fence ON document_files AS RESTRICTIVE FOR ALL TO nazoratly_app
  USING (app_guardian_id() IS NULL OR document_id IN (SELECT d.id FROM documents d))
  WITH CHECK (app_guardian_id() IS NULL);

-- 3. everything else: closed to guardian sessions --------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      AND c.relname NOT IN ('organizations','org_settings','courses','branches')
      AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'guardian_fence')
    ORDER BY c.relname
  LOOP
    EXECUTE format('CREATE POLICY guardian_fence ON %I AS RESTRICTIVE FOR ALL TO nazoratly_app USING (app_guardian_id() IS NULL) WITH CHECK (app_guardian_id() IS NULL)', r.t);
  END LOOP;
END $$;

-- 4. make-up slots ---------------------------------------------------------------------------------------------------
-- Upcoming planned lessons of other active groups of the same course and branch, with the seats left (NULL = no limit).
-- The caller (a guardian session) must be linked to the student of the right; staff sessions are not restricted.
CREATE FUNCTION guardian_makeup_slots(p_entitlement bigint)
RETURNS TABLE (lesson_id bigint, lesson_public_id uuid, group_id bigint, group_name text, teacher_id bigint, lesson_date date,
               start_time time, end_time time, seats_left integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id, l.public_id, g2.id, g2.name, l.teacher_id, l.lesson_date, l.start_time, l.end_time,
         CASE WHEN g2.capacity IS NULL THEN NULL
              ELSE greatest(0, g2.capacity - (SELECT count(*)::int FROM enrollments e2
                                              WHERE e2.org_id = g2.org_id AND e2.group_id = g2.id AND e2.status IN ('trial','active')))
         END
  FROM absence_entitlements ae
  JOIN study_groups g1 ON g1.org_id = ae.org_id AND g1.id = ae.group_id
  JOIN study_groups g2 ON g2.org_id = g1.org_id AND g2.course_id = g1.course_id AND g2.id <> g1.id
                      AND g2.status = 'active' AND g2.branch_id = g1.branch_id AND g2.deleted_at IS NULL
  JOIN lessons l ON l.org_id = g2.org_id AND l.group_id = g2.id AND l.status = 'planned' AND l.kind = 'regular'
  JOIN organizations o ON o.id = ae.org_id
  WHERE ae.id = p_entitlement AND ae.org_id = app_org_id() AND ae.kind = 'makeup' AND ae.status = 'open'
    AND (app_guardian_id() IS NULL OR EXISTS (SELECT 1 FROM student_guardians sg
                                              WHERE sg.org_id = ae.org_id AND sg.student_id = ae.student_id AND sg.guardian_id = app_guardian_id()))
    AND l.lesson_date > (now() AT TIME ZONE o.timezone)::date
    AND l.lesson_date <= ae.expires_on
  ORDER BY l.lesson_date, l.start_time, l.id
$$;
REVOKE ALL ON FUNCTION guardian_makeup_slots(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guardian_makeup_slots(bigint) TO nazoratly_app;
