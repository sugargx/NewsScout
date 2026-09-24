-- PG17 role creation does not itself grant SET ROLE capability to a
-- non-superuser creator. Keep this explicit for the DATABASE_URL login.
DO $$
DECLARE reader_role oid;
BEGIN
  SELECT oid INTO reader_role FROM pg_roles WHERE rolname='scoutnews_reader';
  IF reader_role IS NULL THEN
    RAISE EXCEPTION 'scoutnews_reader must be provisioned before the application starts';
  END IF;
  IF EXISTS (
    SELECT FROM pg_roles WHERE oid=reader_role
      AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole
        OR rolcreatedb OR rolreplication OR rolinherit)
  ) THEN
    RAISE EXCEPTION 'scoutnews_reader must be an unprivileged NOLOGIN NOINHERIT NOBYPASSRLS role';
  END IF;
  IF EXISTS (SELECT FROM pg_auth_members WHERE member=reader_role) THEN
    RAISE EXCEPTION 'scoutnews_reader must not be a member of other roles, including azure_pg_admin';
  END IF;
  IF EXISTS (SELECT FROM pg_class WHERE relowner=reader_role AND relnamespace='public'::regnamespace)
    OR EXISTS (SELECT FROM pg_namespace WHERE nspname='public' AND nspowner=reader_role)
    OR EXISTS (SELECT FROM pg_database WHERE datname=current_database() AND datdba=reader_role)
  THEN
    RAISE EXCEPTION 'scoutnews_reader must not own application tables, schema, or database';
  END IF;
  EXECUTE format('GRANT scoutnews_reader TO %I WITH SET TRUE, INHERIT FALSE',current_user);
END $$;
