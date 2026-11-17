-- ============================================================================
-- Run ONCE as the database admin (e.g. the "admin" user), connected to the
-- database the portal will use:
--
--   psql -h localhost -U admin -d <dbname> -v app_password="'CHANGE_ME_STRONG'" -f sql/000_setup_db_user.sql
--
-- Creates a dedicated login "ess_app" that owns ONLY the "ess" schema.
-- The portal never needs the admin account, and cannot read or change any
-- other schema/table in this database.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ess_app') THEN
    CREATE ROLE ess_app LOGIN;
  END IF;
END$$;

ALTER ROLE ess_app WITH LOGIN PASSWORD :app_password;
ALTER ROLE ess_app SET search_path = ess;

CREATE SCHEMA IF NOT EXISTS ess AUTHORIZATION ess_app;
ALTER SCHEMA ess OWNER TO ess_app;

-- allow connecting to this database (current_database() avoids hard-coding the name)
DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO ess_app', current_database());
END $$;

-- ess_app must not create objects in "public"
REVOKE CREATE ON SCHEMA public FROM ess_app;
