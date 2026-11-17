-- Offer letters + payslips pushed from Google (Apps Script PortalSync) into the portal.
-- PDFs are stored on disk (DOCS_DIR); these tables hold the row data.

CREATE TABLE IF NOT EXISTS ess.offer_letters (
  id               bigserial PRIMARY KEY,
  source_file_id   text NOT NULL UNIQUE,     -- Drive file id of the PDF (from "Offer URL")
  generated_on     text,                     -- normalised "YYYY-MM-DD HH:mm"
  generated_by     text,
  entity           text,
  employee_name    text,
  letter_type      text,
  designation      text,
  category         text,
  state            text,
  kitchen_location text,
  date_of_joining  text,                     -- YYYY-MM-DD when parseable
  date_of_birth    text,                     -- YYYY-MM-DD when parseable (placeholders kept as-is)
  phone            text,                     -- last 10 digits, used for matching
  manager_name     text,
  net_salary       numeric,
  dbt_amount       numeric,
  stored_name      text NOT NULL,
  pdf_size         int NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS offer_letters_phone_idx ON ess.offer_letters (phone);

CREATE TABLE IF NOT EXISTS ess.payslips (
  id               bigserial PRIMARY KEY,
  source_sheet_id  text NOT NULL,            -- entity Payroll spreadsheet id
  employee_id      text NOT NULL,            -- upper-cased "Employee ID"
  pay_year         text NOT NULL,
  pay_month        text NOT NULL,            -- e.g. "September"
  source_file_id   text NOT NULL,            -- Drive id from "PDF File ID"
  data             jsonb NOT NULL,           -- the full payroll row (minus PDF File ID)
  stored_name      text NOT NULL,
  pdf_size         int NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_sheet_id, employee_id, pay_year, pay_month)
);
CREATE INDEX IF NOT EXISTS payslips_emp_idx ON ess.payslips (employee_id);
