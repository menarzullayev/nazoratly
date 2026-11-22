-- 0002_education (up)
-- Why: core education-center domain: students, guardians, consent, teachers, courses, groups, schedule,
--   enrollments, lessons, attendance.
-- Queries supported (each index below names its query):
--   Q-stu-1  search students by name (trigram)                     -> students_name_trgm
--   Q-stu-2  list active students of a center                      -> students_org_status
--   Q-grp-1  members of a group (active enrollments)               -> enrollments_group_active
--   Q-grp-2  groups of a teacher                                   -> study_groups_teacher
--   Q-att-1  attendance of a lesson (roll call)                    -> attendance_lesson_student_key
--   Q-att-2  attendance of a group for a month                     -> lessons_group_date + attendance_lesson_student_key
--   Q-att-3  students with many absences                           -> attendance_absent
--   Q-les-1  lessons of a teacher in a month (payroll)             -> lessons_teacher_date
--   Q-con-1  active consent of a student per purpose               -> data_consents_active_key
-- Tenant safety: every child references its parent as (org_id, parent_id), so a row can never point to
--   another center's row.

CREATE TABLE students (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL,
  public_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  full_name   TEXT NOT NULL CHECK (length(btrim(full_name)) > 0),
  birth_date  DATE CHECK (birth_date <= CURRENT_DATE),
  phone       phone_e164,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('lead','active','paused','graduated','left')),
  joined_on   DATE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  CONSTRAINT students_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT students_public_id_key UNIQUE (public_id),
  CONSTRAINT students_org_id_key UNIQUE (org_id, id)
);
CREATE INDEX students_org_status ON students (org_id, status) WHERE deleted_at IS NULL;
CREATE INDEX students_name_trgm ON students USING gin (full_name gin_trgm_ops) WHERE deleted_at IS NULL;

CREATE TABLE guardians (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id           BIGINT NOT NULL,
  public_id        UUID NOT NULL DEFAULT gen_random_uuid(),
  full_name        TEXT NOT NULL CHECK (length(btrim(full_name)) > 0),
  phone            phone_e164,
  telegram_chat_id BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT guardians_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT guardians_public_id_key UNIQUE (public_id),
  CONSTRAINT guardians_org_id_key UNIQUE (org_id, id),
  CONSTRAINT guardians_has_contact CHECK (phone IS NOT NULL OR telegram_chat_id IS NOT NULL)
);
-- find a guardian by phone when a parent writes in
CREATE INDEX guardians_org_phone ON guardians (org_id, phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE student_guardians (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL,
  student_id         BIGINT NOT NULL,
  guardian_id        BIGINT NOT NULL,
  relation           TEXT NOT NULL CHECK (relation IN ('mother','father','guardian','self','other')),
  is_primary         BOOLEAN NOT NULL DEFAULT FALSE,
  receives_reminders BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT student_guardians_student_fk  FOREIGN KEY (org_id, student_id)  REFERENCES students(org_id, id)  ON DELETE CASCADE,
  CONSTRAINT student_guardians_guardian_fk FOREIGN KEY (org_id, guardian_id) REFERENCES guardians(org_id, id) ON DELETE CASCADE,
  CONSTRAINT student_guardians_pair_key UNIQUE (student_id, guardian_id),
  CONSTRAINT student_guardians_org_id_key UNIQUE (org_id, id)
);
-- at most one primary guardian per student
CREATE UNIQUE INDEX student_guardians_one_primary ON student_guardians (student_id) WHERE is_primary;
-- "which students does this guardian have" + FK lookup
CREATE INDEX student_guardians_by_guardian ON student_guardians (org_id, guardian_id);

-- Personal-data consent, one row per (student, purpose) while active. Required for notifications and for any
-- AI-assistant processing (see 0004/0005). Revocation is a timestamp, never a delete.
CREATE TABLE data_consents (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id                BIGINT NOT NULL,
  student_id            BIGINT NOT NULL,
  given_by_guardian_id  BIGINT,
  given_by_self         BOOLEAN NOT NULL DEFAULT FALSE,
  purpose               TEXT NOT NULL CHECK (purpose IN ('data_processing','notifications','ai_assistant_processing','marketing')),
  policy_version        TEXT NOT NULL CHECK (length(btrim(policy_version)) > 0),
  evidence              TEXT,                                -- reference to the signed form / message id
  granted_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at            TIMESTAMPTZ,
  CONSTRAINT data_consents_student_fk  FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT data_consents_guardian_fk FOREIGN KEY (org_id, given_by_guardian_id) REFERENCES guardians(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT data_consents_given_by CHECK (given_by_guardian_id IS NOT NULL OR given_by_self),
  CONSTRAINT data_consents_revoke_order CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  CONSTRAINT data_consents_org_id_key UNIQUE (org_id, id)
);
-- Q-con-1: one active consent per (student, purpose)
CREATE UNIQUE INDEX data_consents_active_key ON data_consents (student_id, purpose) WHERE revoked_at IS NULL;
CREATE INDEX data_consents_guardian ON data_consents (org_id, given_by_guardian_id) WHERE given_by_guardian_id IS NOT NULL;

CREATE TABLE teachers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL,
  public_id   UUID NOT NULL DEFAULT gen_random_uuid(),
  user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  full_name   TEXT NOT NULL CHECK (length(btrim(full_name)) > 0),
  phone       phone_e164,
  pay_model   TEXT NOT NULL DEFAULT 'per_lesson' CHECK (pay_model IN ('fixed','per_lesson','percent')),
  pay_rate    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (pay_rate >= 0),   -- so'm per month / per lesson, or percent
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  hired_on    DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  CONSTRAINT teachers_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT teachers_public_id_key UNIQUE (public_id),
  CONSTRAINT teachers_org_id_key UNIQUE (org_id, id),
  CONSTRAINT teachers_percent_range CHECK (pay_model <> 'percent' OR pay_rate <= 100)
);
-- FK lookup user -> teacher profile
CREATE INDEX teachers_user ON teachers (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX teachers_org_status ON teachers (org_id, status) WHERE deleted_at IS NULL;

CREATE TABLE courses (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id              BIGINT NOT NULL,
  name                TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  description         TEXT,
  default_monthly_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (default_monthly_fee >= 0),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  CONSTRAINT courses_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT courses_org_id_key UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX courses_org_name_live ON courses (org_id, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE rooms (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL,
  branch_id   BIGINT NOT NULL,
  name        TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  capacity    INTEGER CHECK (capacity > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rooms_branch_fk FOREIGN KEY (org_id, branch_id) REFERENCES branches(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT rooms_branch_name_key UNIQUE (branch_id, name),
  CONSTRAINT rooms_org_id_key UNIQUE (org_id, id)
);

CREATE TABLE study_groups (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL,
  public_id    UUID NOT NULL DEFAULT gen_random_uuid(),
  branch_id    BIGINT,
  course_id    BIGINT NOT NULL,
  teacher_id   BIGINT,
  name         TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  monthly_fee  NUMERIC(14,2) NOT NULL CHECK (monthly_fee >= 0),
  capacity     INTEGER CHECK (capacity > 0),
  start_date   DATE NOT NULL,
  end_date     DATE,
  status       TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','finished','cancelled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  CONSTRAINT study_groups_branch_fk  FOREIGN KEY (org_id, branch_id)  REFERENCES branches(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT study_groups_course_fk  FOREIGN KEY (org_id, course_id)  REFERENCES courses(org_id, id)  ON DELETE RESTRICT,
  CONSTRAINT study_groups_teacher_fk FOREIGN KEY (org_id, teacher_id) REFERENCES teachers(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT study_groups_public_id_key UNIQUE (public_id),
  CONSTRAINT study_groups_org_id_key UNIQUE (org_id, id),
  CONSTRAINT study_groups_dates CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX study_groups_org_name_live ON study_groups (org_id, lower(name)) WHERE deleted_at IS NULL;
-- Q-grp-2: groups of a teacher
CREATE INDEX study_groups_teacher ON study_groups (org_id, teacher_id) WHERE teacher_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX study_groups_course ON study_groups (org_id, course_id);
CREATE INDEX study_groups_branch ON study_groups (org_id, branch_id) WHERE branch_id IS NOT NULL;

CREATE TABLE group_schedules (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      BIGINT NOT NULL,
  group_id    BIGINT NOT NULL,
  weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 7),         -- ISO: 1 = Monday
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  room_id     BIGINT,
  CONSTRAINT group_schedules_group_fk FOREIGN KEY (org_id, group_id) REFERENCES study_groups(org_id, id) ON DELETE CASCADE,
  CONSTRAINT group_schedules_room_fk  FOREIGN KEY (org_id, room_id)  REFERENCES rooms(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT group_schedules_time CHECK (end_time > start_time),
  CONSTRAINT group_schedules_slot_key UNIQUE (group_id, weekday, start_time)
);
CREATE INDEX group_schedules_room ON group_schedules (org_id, room_id) WHERE room_id IS NOT NULL;

CREATE TABLE enrollments (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id               BIGINT NOT NULL,
  student_id           BIGINT NOT NULL,
  group_id             BIGINT NOT NULL,
  started_on           DATE NOT NULL,
  ended_on             DATE,
  monthly_fee_override NUMERIC(14,2) CHECK (monthly_fee_override >= 0),
  discount_percent     NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','frozen','finished')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT enrollments_student_fk FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id)     ON DELETE RESTRICT,
  CONSTRAINT enrollments_group_fk   FOREIGN KEY (org_id, group_id)   REFERENCES study_groups(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT enrollments_dates CHECK (ended_on IS NULL OR ended_on >= started_on),
  CONSTRAINT enrollments_finished_has_end CHECK (status <> 'finished' OR ended_on IS NOT NULL),
  CONSTRAINT enrollments_org_id_key UNIQUE (org_id, id)
);
-- a student is in a group at most once while the enrollment is open
CREATE UNIQUE INDEX enrollments_open_pair ON enrollments (student_id, group_id) WHERE status IN ('active','frozen');
-- Q-grp-1: members of a group
CREATE INDEX enrollments_group_active ON enrollments (group_id) WHERE status = 'active';
-- groups of a student
CREATE INDEX enrollments_student ON enrollments (org_id, student_id);

CREATE TABLE lessons (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id       BIGINT NOT NULL,
  group_id     BIGINT NOT NULL,
  teacher_id   BIGINT,                              -- who actually taught (may differ from the group's teacher)
  room_id      BIGINT,
  lesson_date  DATE NOT NULL,
  start_time   TIME NOT NULL,
  end_time     TIME NOT NULL,
  status       TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','held','cancelled')),
  topic        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lessons_group_fk   FOREIGN KEY (org_id, group_id)   REFERENCES study_groups(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT lessons_teacher_fk FOREIGN KEY (org_id, teacher_id) REFERENCES teachers(org_id, id)     ON DELETE RESTRICT,
  CONSTRAINT lessons_room_fk    FOREIGN KEY (org_id, room_id)    REFERENCES rooms(org_id, id)        ON DELETE RESTRICT,
  CONSTRAINT lessons_time CHECK (end_time > start_time),
  CONSTRAINT lessons_slot_key UNIQUE (group_id, lesson_date, start_time),
  CONSTRAINT lessons_org_id_key UNIQUE (org_id, id)
);
-- Q-att-2: lessons of a group in a date range
CREATE INDEX lessons_group_date ON lessons (group_id, lesson_date);
-- Q-les-1: lessons a teacher held in a month (payroll)
CREATE INDEX lessons_teacher_date ON lessons (org_id, teacher_id, lesson_date) WHERE teacher_id IS NOT NULL;
CREATE INDEX lessons_org_date ON lessons (org_id, lesson_date);
CREATE INDEX lessons_room ON lessons (org_id, room_id) WHERE room_id IS NOT NULL;

CREATE TABLE attendance (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id            BIGINT NOT NULL,
  lesson_id         BIGINT NOT NULL,
  student_id        BIGINT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('present','absent','late','excused')),
  minutes_late      SMALLINT NOT NULL DEFAULT 0 CHECK (minutes_late >= 0),
  marked_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  marked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT attendance_lesson_fk  FOREIGN KEY (org_id, lesson_id)  REFERENCES lessons(org_id, id)  ON DELETE CASCADE,
  CONSTRAINT attendance_student_fk FOREIGN KEY (org_id, student_id) REFERENCES students(org_id, id) ON DELETE RESTRICT,
  CONSTRAINT attendance_late_minutes CHECK (status = 'late' OR minutes_late = 0),
  CONSTRAINT attendance_lesson_student_key UNIQUE (lesson_id, student_id)       -- Q-att-1
);
-- Q-att-3: absences per student
CREATE INDEX attendance_absent ON attendance (student_id, lesson_id) WHERE status = 'absent';
-- history of one student
CREATE INDEX attendance_student ON attendance (org_id, student_id);

-- A student can only be marked in a lesson of a group they are (or were) enrolled in.
CREATE FUNCTION check_attendance_enrolled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM lessons l
    JOIN enrollments e ON e.org_id = l.org_id AND e.group_id = l.group_id AND e.student_id = NEW.student_id
    WHERE l.org_id = NEW.org_id AND l.id = NEW.lesson_id
  ) THEN
    RAISE EXCEPTION 'student % is not enrolled in the group of lesson %', NEW.student_id, NEW.lesson_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_attendance_enrolled BEFORE INSERT OR UPDATE OF lesson_id, student_id ON attendance
  FOR EACH ROW EXECUTE FUNCTION check_attendance_enrolled();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['students','guardians','teachers','courses','rooms','study_groups','enrollments','lessons'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   'trg_' || t || '_updated_at', t);
  END LOOP;
END $$;
