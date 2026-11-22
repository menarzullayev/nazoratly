-- 0001_foundation (down). DESTRUCTIVE: drops tenancy, users and memberships with all their data.
-- Only run on an empty/disposable database or after a verified backup.
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS branches;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS organizations;
DROP DOMAIN IF EXISTS phone_e164;
DROP FUNCTION IF EXISTS set_updated_at();
DROP FUNCTION IF EXISTS app_actor_type();
DROP FUNCTION IF EXISTS app_agent_client_id();
DROP FUNCTION IF EXISTS app_user_id();
DROP FUNCTION IF EXISTS app_org_id();
-- extensions (citext, pg_trgm) are intentionally left installed: other schemas may use them.
