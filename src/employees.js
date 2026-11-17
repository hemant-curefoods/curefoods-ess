'use strict';
// Employee Master helpers: DB column <-> the column names the frontend and the
// Excel export use ("Employee Code", "Date Of Birth", ...), plus role derivation.
const { query } = require('./db');
const config = require('./config');

// [db column, Excel/frontend header, ...extra accepted header spellings]
const COLUMNS = [
  ['employee_code', 'Employee Code', 'Emp Code', 'Employee ID', 'Emp ID'],
  ['employee_name', 'Employee Name', 'Name', 'Full Name'],
  ['first_name', 'First Name'],
  ['mobile_number', 'Mobile Number', 'Mobile', 'Phone Number', 'Mobile No'],
  ['date_of_birth', 'Date Of Birth', 'DOB', 'Birth Date'],
  ['employment_status', 'Employment Status', 'Status'],
  ['designation', 'Designation'],
  ['department', 'Department'],
  ['entity', 'Entity'],
  ['company', 'Company'],
  ['base_location', 'Base location (Office)', 'Base Location', 'Location'],
  ['state', 'State'],
  ['hr_manager_code', 'HR Manager Code', 'HRBP Code'],
  ['hr_manager', 'HR Manager', 'HRBP'],
  ['l1_manager_code', 'L1 Manager Code', 'Reporting Manager Code'],
  ['l1_manager', 'L1 Manager', 'Reporting Manager'],
  ['l2_manager', 'L2 Manager'],
  ['gender', 'Gender'],
  ['date_of_joining', 'Date of Joining', 'DOJ', 'Joining Date'],
  ['employment_type', 'Employment Type'],
  ['employee_category', 'Employee Category'],
  ['grade', 'Grade'],
  ['band', 'Band'],
  ['management_level', 'Management Level'],
  ['confirmation_status', 'Confirmation Status'],
  ['notice_period', 'Notice Period'],
  ['office_email', 'Office Email Address', 'Office Email', 'Official Email'],
  ['personal_email', 'Personal Email Address', 'Personal Email'],
  ['blood_group', 'BloodGroup', 'Blood Group'],
];
const DATE_COLUMNS = new Set(['date_of_birth', 'date_of_joining']);

function digits(s) {
  return String(s || '').replace(/\D/g, '').slice(-10);
}
function maskedMobile(m) {
  const d = digits(m);
  return d ? 'XXXXXX' + d.slice(-4) : '';
}
function isActive(row) {
  return row && String(row.employment_status || '').trim().toLowerCase() === 'active';
}

async function getEmployee(code) {
  const r = await query('SELECT * FROM ess.employees WHERE upper(employee_code) = upper($1)', [String(code || '').trim()]);
  return r.rows[0] || null;
}

async function namesFor(codes) {
  const list = [...new Set(codes.filter(c => c && c !== 'system').map(c => String(c).toUpperCase()))];
  if (!list.length) return {};
  const r = await query('SELECT employee_code, employee_name FROM ess.employees WHERE upper(employee_code) = ANY($1)', [list]);
  const out = {};
  r.rows.forEach(x => { out[x.employee_code] = x.employee_name; });
  return out;
}

// Role rules (same as the prototype):
//   HR Head  -> listed in HR_HEAD_CODES
//   HR       -> appears as "HR Manager Code" of any ACTIVE employee
//   L1       -> appears as "L1 Manager Code" of any ACTIVE employee
//   Employee -> everyone else.  Admin is an extra flag from ADMIN_CODES.
async function rolesFor(code) {
  const c = String(code).toUpperCase();
  const r = await query(
    `SELECT
       EXISTS(SELECT 1 FROM ess.employees WHERE upper(hr_manager_code) = $1 AND lower(employment_status) = 'active') AS is_hr,
       EXISTS(SELECT 1 FROM ess.employees WHERE upper(l1_manager_code) = $1 AND lower(employment_status) = 'active') AS is_l1`,
    [c]
  );
  const { is_hr, is_l1 } = r.rows[0];
  const role = config.hrHeadCodes.includes(c) ? 'hrhead' : is_hr ? 'hr' : is_l1 ? 'l1' : 'employee';
  return { role, isAdmin: config.adminCodes.includes(c), isL1: !!is_l1 };
}

function isHrRole(role) {
  return role === 'hr' || role === 'hrhead';
}

// Active HR users (HR partners + HR Head) for reassignment.
async function hrList() {
  const r = await query(
    `SELECT e.employee_code, e.employee_name, e.designation
       FROM ess.employees e
      WHERE lower(e.employment_status) = 'active'
        AND (upper(e.employee_code) = ANY($1)
             OR EXISTS (SELECT 1 FROM ess.employees x
                         WHERE upper(x.hr_manager_code) = upper(e.employee_code)
                           AND lower(x.employment_status) = 'active'))
      ORDER BY e.employee_name`,
    [config.hrHeadCodes]
  );
  return r.rows;
}

async function hrHead() {
  for (const code of config.hrHeadCodes) {
    const e = await getEmployee(code);
    if (isActive(e)) return e;
  }
  return null;
}

// Who a new ticket goes to (same rules as the prototype):
// 1) POSH -> HR Head (confidential). 2) employee's HR partner if an active HR user
// and not themselves. 3) fallback to HR Head (or another HR if the raiser is the HR Head).
async function routeTicket(emp, category) {
  const head = await hrHead();
  if (!head) throw new Error('HR_HEAD_CODES does not match an active employee');
  const isHeadRaiser = head.employee_code === emp.employee_code;
  if (category === 'POSH' && !isHeadRaiser) return { emp: head, why: 'POSH cases go directly to the HR Head' };
  if (emp.hr_manager_code && emp.hr_manager_code.toUpperCase() !== emp.employee_code.toUpperCase()) {
    const hr = await getEmployee(emp.hr_manager_code);
    if (isActive(hr)) {
      const roles = await rolesFor(hr.employee_code);
      if (isHrRole(roles.role)) return { emp: hr, why: 'Your HR partner as per the Employee Master' };
    }
  }
  if (!isHeadRaiser) return { emp: head, why: 'No HR partner mapped — routed to the HR desk' };
  const other = (await hrList()).find(h => h.employee_code !== head.employee_code);
  return { emp: other || head, why: 'No HR partner mapped — routed to the HR desk' };
}

// Shape sent to the browser. Uses the same keys as the prototype.
// The full mobile number never leaves the server (only the last 4 digits).
async function toClient(row, extra) {
  const out = {};
  COLUMNS.forEach(([col, header]) => { out[header] = row[col] == null ? '' : row[col]; });
  out['Mobile Number'] = maskedMobile(row.mobile_number);
  const roles = await rolesFor(row.employee_code);
  out['Role'] = roles.role;
  out['Is Admin'] = roles.isAdmin;
  out['Is L1'] = roles.isL1;
  // routing preview for the "Raise ticket" form (server re-checks on submit)
  if (!extra || extra.route !== false) {
    try {
      const partner = await routeTicket(row, 'Other');
      const head = await hrHead();
      out._route = {
        partner: { code: partner.emp.employee_code, name: partner.emp.employee_name, why: partner.why },
        head: head ? { code: head.employee_code, name: head.employee_name } : null,
      };
    } catch (e) { out._route = null; }
  }
  return out;
}

module.exports = {
  COLUMNS, DATE_COLUMNS, digits, maskedMobile, isActive,
  getEmployee, namesFor, rolesFor, isHrRole, hrList, hrHead, routeTicket, toClient,
};
