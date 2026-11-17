'use strict';
// Writes templates/employee_master_template.xlsx with the expected headers + 2 dummy rows.
const path = require('path');
const ExcelJS = require('exceljs');
const { COLUMNS } = require('../src/employees');

(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Employee Master');
  const headers = COLUMNS.map(c => c[1]);
  ws.addRow(headers);
  const sample = {
    'Employee Code': ['CFD00001', 'CFD00002'], 'Employee Name': ['Sample Employee', 'Sample HR Partner'],
    'First Name': ['Sample', 'Sample'], 'Mobile Number': ['9000000001', '9000000002'],
    'Date Of Birth': ['1995-04-12', '1990-12-08'], 'Employment Status': ['Active', 'Active'],
    'Designation': ['Store Associate', 'Manager — HRBP'], 'Department': ['Store Operations', 'Human Resources'],
    'Entity': ['Curefoods — Indiranagar', 'Curefoods India Pvt. Ltd.'], 'Company': ['Curefoods India Pvt. Ltd.', 'Curefoods India Pvt. Ltd.'],
    'Base location (Office)': ['Karnataka_IND - 01', 'Karnataka_CORP - 15'], 'State': ['Karnataka', 'Karnataka'],
    'HR Manager Code': ['CFD00002', ''], 'HR Manager': ['Sample HR Partner', ''],
    'Date of Joining': ['2023-11-03', '2020-08-17'], 'Employment Type': ['Permanent', 'Permanent'],
  };
  for (let i = 0; i < 2; i++) ws.addRow(headers.map(h => (sample[h] ? sample[h][i] : '')));
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach(c => { c.width = 22; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ['Mobile Number', 'Date Of Birth', 'Date of Joining'].forEach(h => { ws.getColumn(headers.indexOf(h) + 1).numFmt = '@'; });
  const out = path.join(__dirname, '..', 'templates', 'employee_master_template.xlsx');
  await wb.xlsx.writeFile(out);
  console.log('Wrote ' + out);
})();
