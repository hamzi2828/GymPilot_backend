// services/xlsx.js: a real workbook -- a valid zip of the parts Excel needs,
// numbers as numbers, date keys as dates, text as text (never a formula),
// the header row bold -- read back with an independent reader.

const test = require('node:test');
const assert = require('node:assert/strict');

const xlsx = require('../../src/services/xlsx');
const { unzip, readSheet, sheetNames, sheetObjects } = require('../helpers/readXlsx');

const columns = [
  { key: 'name', label: 'Name' },
  { key: 'amount', label: 'Amount' },
  { key: 'paidOn', label: 'Paid on', type: 'date' },
  { key: 'code', label: 'Code' },
  { key: 'hours', label: 'Hours', type: 'number' }
];

test('the workbook is a zip of the parts Excel needs, every CRC right', () => {
  const buffer = xlsx.toXlsx([{ name: 'Orders', columns, rows: [] }]);
  assert.equal(buffer.readUInt32LE(0), 0x04034b50, 'starts with a zip local header');
  const files = unzip(buffer);
  assert.deepEqual(
    [...files.keys()].sort(),
    ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']
  );
  const types = files.get('[Content_Types].xml').toString();
  assert.match(types, /PartName="\/xl\/worksheets\/sheet1\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.worksheet\+xml"/);
  assert.match(files.get('xl/_rels/workbook.xml.rels').toString(), /Target="worksheets\/sheet1\.xml"/);
  assert.deepEqual(sheetNames(files), ['Orders']);
});

test('numbers are number cells, date keys are dates, text is text and never a formula', () => {
  const rows = [
    { name: 'Ann <A&B>', amount: 12.5, paidOn: '2026-08-03', code: '=HYPERLINK("x")', hours: '7.5' },
    { name: '  padded  ', amount: -40, paidOn: '', code: 'M-001', hours: null },
    { name: 'Zero', amount: 0, paidOn: 'not a date', code: '007', hours: 'n/a' }
  ];
  const files = unzip(xlsx.toXlsx([{ name: 'Orders', columns, rows }]));
  const sheet = readSheet(files);
  const xml = files.get('xl/worksheets/sheet1.xml').toString();

  // Header: bold text.
  assert.deepEqual(sheet[0].map((c) => [c.ref, c.type, c.style, c.value]), [
    ['A1', 's', 1, 'Name'],
    ['B1', 's', 1, 'Amount'],
    ['C1', 's', 1, 'Paid on'],
    ['D1', 's', 1, 'Code'],
    ['E1', 's', 1, 'Hours']
  ]);

  const [first, second, third] = sheet.slice(1);
  assert.deepEqual(first.map((c) => [c.ref, c.type, c.style, c.value]), [
    ['A2', 's', 0, 'Ann <A&B>'],
    ['B2', 'n', 0, 12.5],
    // 3 Aug 2026 is day 46237 counting from 30 Dec 1899, in the date style.
    ['C2', 'n', 2, 46237],
    ['D2', 's', 0, '=HYPERLINK("x")'],
    ['E2', 'n', 0, 7.5]
  ]);
  assert.ok(!/<f>/.test(xml), 'no formulas anywhere');
  assert.match(xml, /Ann &lt;A&amp;B&gt;/);

  // Blank cells are left out; leading spaces kept; negative numbers stay numbers.
  assert.deepEqual(second.map((c) => [c.ref, c.value]), [['A3', '  padded  '], ['B3', -40], ['D3', 'M-001']]);
  assert.match(xml, /<t xml:space="preserve">  padded  <\/t>/);

  // A string that is not a date or a number stays text; a code with a leading
  // zero is only a number when its column says so.
  assert.deepEqual(third.map((c) => [c.ref, c.type, c.value]), [
    ['A4', 's', 'Zero'],
    ['B4', 'n', 0],
    ['C4', 's', 'not a date'],
    ['D4', 's', '007'],
    ['E4', 's', 'n/a']
  ]);
});

test('value() columns, a bold totals footer, several sheets with safe names', () => {
  const files = unzip(
    xlsx.toXlsx([
      {
        name: 'Daily sales',
        columns: [
          { key: 'date', label: 'Date', type: 'date' },
          { key: 'total', label: 'Total', value: (r) => r.a + r.b }
        ],
        rows: [{ date: '2026-08-01', a: 1, b: 2 }],
        footer: { date: 'Total', a: 10, b: 20 }
      },
      { name: 'By method: [cash/card]?', columns: [{ key: 'm', label: 'Method' }], rows: [{ m: 'Cash' }] },
      { name: 'daily sales', columns: [{ key: 'x', label: 'X' }], rows: [] }
    ])
  );
  assert.deepEqual(sheetNames(files), ['Daily sales', 'By method   cash card', 'daily sales (2)']);
  const sheet = readSheet(files, 1);
  assert.deepEqual(sheet[1].map((c) => c.value), [46235, 3]);
  // Footer: bold, and a label in a date column stays a (bold) label.
  assert.deepEqual(sheet[2].map((c) => [c.type, c.style, c.value]), [['s', 1, 'Total'], ['n', 1, 30]]);
  assert.deepEqual(sheetObjects(files, 2), [{ Method: 'Cash' }]);
});

test('control characters that XML cannot hold are dropped, not left to corrupt the file', () => {
  const files = unzip(xlsx.toXlsx([{ name: 'S', columns: [{ key: 'v', label: 'V' }], rows: [{ v: 'a\u0000b\u0007c\td' }] }]));
  assert.equal(readSheet(files)[1][0].value, 'abc\td');
});

test('sendXlsx answers with the spreadsheet type and a safe file name', () => {
  const headers = {};
  let body;
  const res = { setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, send: (b) => { body = b; return res; } };
  xlsx.sendXlsx(res, 'orders 2026/08.xlsx', [{ key: 'a', label: 'A' }], [{ a: 1 }]);
  assert.equal(headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(headers['content-disposition'], 'attachment; filename="orders_2026_08.xlsx"');
  assert.ok(Buffer.isBuffer(body));
  assert.deepEqual(sheetObjects(unzip(body)), [{ A: 1 }]);
});

test('column letters and date serials', () => {
  assert.deepEqual([0, 25, 26, 51, 52, 701, 702].map(xlsx.columnLetter), ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
  assert.equal(xlsx.dateSerial('1900-03-01'), 61);
  assert.equal(xlsx.dateSerial('2026-01-01'), 46023);
  assert.equal(xlsx.dateSerial('01/01/2026'), null);
});
