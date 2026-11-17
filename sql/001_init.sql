-- Curefoods ESS portal — schema "ess". Idempotent: safe to run more than once.
-- (schema normally created by 000_setup_db_user.sql; only create it here if missing)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ess') THEN CREATE SCHEMA ess; END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Employee Master (loaded from Excel via `npm run import:employees`)
-- Column comments give the matching header in the Excel / HR export.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ess.employees (
  employee_code        text PRIMARY KEY,          -- Employee Code
  employee_name        text NOT NULL,             -- Employee Name
  first_name           text,                      -- First Name
  mobile_number        text,                      -- Mobile Number
  date_of_birth        date,                      -- Date Of Birth
  employment_status    text NOT NULL DEFAULT 'Active', -- Employment Status (Active / Exited)
  designation          text,                      -- Designation
  department           text,                      -- Department
  entity               text,                      -- Entity
  company              text,                      -- Company
  base_location        text,                      -- Base location (Office)
  state                text,                      -- State
  hr_manager_code      text,                      -- HR Manager Code
  hr_manager           text,                      -- HR Manager
  l1_manager_code      text,                      -- L1 Manager Code
  l1_manager           text,                      -- L1 Manager
  l2_manager           text,                      -- L2 Manager
  gender               text,                      -- Gender
  date_of_joining      date,                      -- Date of Joining
  employment_type      text,                      -- Employment Type
  employee_category    text,                      -- Employee Category
  grade                text,                      -- Grade
  band                 text,                      -- Band
  management_level     text,                      -- Management Level
  confirmation_status  text,                      -- Confirmation Status
  notice_period        text,                      -- Notice Period
  office_email         text,                      -- Office Email Address
  personal_email       text,                      -- Personal Email Address
  blood_group          text,                      -- BloodGroup
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS employees_hr_mgr_idx ON ess.employees (upper(hr_manager_code));
CREATE INDEX IF NOT EXISTS employees_l1_mgr_idx ON ess.employees (upper(l1_manager_code));

-- ---------------------------------------------------------------------------
-- Sign-in: one row per employee who has started sign-in
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ess.auth (
  employee_code  text PRIMARY KEY REFERENCES ess.employees(employee_code) ON DELETE CASCADE,
  pin_hash       text,
  pin_set_on     timestamptz,
  fails          int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  reset_on       timestamptz,
  reset_by       text
);

-- Sessions: tokens are stored only as SHA-256 hashes.
-- kind: 'user' (normal sign-in) | 'setup' (DOB verified, PIN not yet set) | 'viewas' (admin read-only)
CREATE TABLE IF NOT EXISTS ess.sessions (
  token_hash     text PRIMARY KEY,
  employee_code  text NOT NULL REFERENCES ess.employees(employee_code) ON DELETE CASCADE,
  kind           text NOT NULL DEFAULT 'user',
  viewed_by      text,           -- admin code for 'viewas' sessions
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  ip             text,
  user_agent     text
);
CREATE INDEX IF NOT EXISTS sessions_emp_idx ON ess.sessions (employee_code);
CREATE INDEX IF NOT EXISTS sessions_exp_idx ON ess.sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Helpdesk
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS ess.ticket_seq START 1001;

CREATE TABLE IF NOT EXISTS ess.tickets (
  id           text PRIMARY KEY DEFAULT ('HD-' || nextval('ess.ticket_seq')),
  raised_by    text NOT NULL REFERENCES ess.employees(employee_code),
  category     text NOT NULL,
  description  text NOT NULL,
  assigned_to  text NOT NULL REFERENCES ess.employees(employee_code),
  status       text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','In Progress','Closed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS tickets_raised_idx   ON ess.tickets (raised_by);
CREATE INDEX IF NOT EXISTS tickets_assigned_idx ON ess.tickets (assigned_to, status);

CREATE TABLE IF NOT EXISTS ess.ticket_events (
  id         bigserial PRIMARY KEY,
  ticket_id  text NOT NULL REFERENCES ess.tickets(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  by_code    text NOT NULL,                -- employee code, or 'system'
  type       text NOT NULL,                -- created | assigned | reassigned | remark | closed
  text       text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ticket_events_ticket_idx ON ess.ticket_events (ticket_id, at);

CREATE TABLE IF NOT EXISTS ess.ticket_files (
  id           uuid PRIMARY KEY,
  ticket_id    text NOT NULL REFERENCES ess.tickets(id) ON DELETE CASCADE,
  name         text NOT NULL,
  size         int NOT NULL,
  mime         text NOT NULL,
  stored_name  text NOT NULL,              -- file name inside UPLOAD_DIR
  uploaded_by  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_files_ticket_idx ON ess.ticket_files (ticket_id);

-- ---------------------------------------------------------------------------
-- Audit log: PIN set/reset, lockouts, view-as, sign-ins
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ess.audit_log (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  actor    text,               -- employee code doing the action (or null)
  action   text NOT NULL,
  target   text,               -- employee code / ticket id affected
  detail   jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip       text
);
CREATE INDEX IF NOT EXISTS audit_at_idx ON ess.audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_target_idx ON ess.audit_log (target);
