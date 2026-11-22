-- 0002_education (down). DESTRUCTIVE: removes all education data (students, attendance, enrollments...).
-- Only on a disposable database or after a verified backup.
DROP TABLE IF EXISTS attendance;
DROP FUNCTION IF EXISTS check_attendance_enrolled();
DROP TABLE IF EXISTS lessons;
DROP TABLE IF EXISTS enrollments;
DROP TABLE IF EXISTS group_schedules;
DROP TABLE IF EXISTS study_groups;
DROP TABLE IF EXISTS rooms;
DROP TABLE IF EXISTS courses;
DROP TABLE IF EXISTS teachers;
DROP TABLE IF EXISTS data_consents;
DROP TABLE IF EXISTS student_guardians;
DROP TABLE IF EXISTS guardians;
DROP TABLE IF EXISTS students;
