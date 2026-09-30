// src/services/xlsx.js
//
// Rows to a real Excel workbook (.xlsx): amounts arrive as numbers Excel can
// add up and dates as dates it can sort and filter, where the CSV exports
// hand it text it has to guess at.
//
// Written by hand rather than with a library. An .xlsx is a zip of a few
// small XML files, and the zip is Node's own deflate (zlib) with a CRC-32 --
// no dependency, so nothing that could turn out to be ESM-only and crash on
// Vercel, whose functions cannot require() an ES module.
//
// Columns are the same shape sendCsv takes -- { key, label, value?(row) } --
// plus an optional `type`:
//   'date'    a 'YYYY-MM-DD' string (what the exports already produce, in the
//             gym's own timezone) becomes a real date cell
//   'number'  a numeric string becomes a number cell
// Without one, a JS number is a number cell and everything else is text.
// Text is always stored as text (an inline string), never as a formula, so a
// member called "=HYPERLINK(...)" is just a name here.

const zlib = require('zlib');

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// Cell styles, by their index in styles.xml's cellXfs.
const STYLE = { plain: 0, bold: 1, date: 2, boldDate: 3 };

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// Zip: every entry deflated, no zip64 -- an export is nowhere near 4 GB
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// The DOS date and time a zip entry carries.
function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, day: day & 0xffff };
}

/** @param {Array<{ name: string, data: Buffer|string }>} files */
function zip(files, now = new Date()) {
  const { time, day } = dosStamp(now);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by 2.0
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal and external attributes: all zero
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + packed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

// XML 1.0 has no place for most control characters; a stray one from a
// pasted name would make Excel call the whole file corrupt.
function xmlText(value) {
  return String(value)
    .replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnLetter(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Excel's serial day number for a 'YYYY-MM-DD', or null. */
function dateSerial(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // A Date is taken as the calendar day it is in UTC. The exports pass
    // date keys already in the gym's timezone instead, which is the point.
    return Math.floor((value.getTime() - EXCEL_EPOCH) / DAY_MS);
  }
  const match = DATE_KEY.exec(String(value).trim());
  if (!match) return null;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.round((at - EXCEL_EPOCH) / DAY_MS);
}

function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function textOf(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function cellXml(ref, value, type, bold) {
  if (value === null || value === undefined || value === '') return '';

  if (type === 'date') {
    const serial = dateSerial(value);
    if (serial !== null) return `<c r="${ref}" s="${bold ? STYLE.boldDate : STYLE.date}"><v>${serial}</v></c>`;
  }

  const number = type === 'number' ? numberOf(value) : typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (number !== null) return `<c r="${ref}"${bold ? ` s="${STYLE.bold}"` : ''}><v>${number}</v></c>`;

  const text = textOf(value);
  if (!text) return '';
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr"${bold ? ` s="${STYLE.bold}"` : ''}><is><t${preserve}>${xmlText(text)}</t></is></c>`;
}

function valueOf(column, row) {
  return column.value ? column.value(row) : row[column.key];
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

// Excel's rules for a tab name: 31 characters, none of []:*?/\, not blank.
function sheetName(name, index, taken) {
  let clean = String(name || '').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Sheet${index + 1}`;
  let n = 2;
  while (taken.has(clean.toLowerCase())) {
    const suffix = ` (${n})`;
    clean = `${clean.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  taken.add(clean.toLowerCase());
  return clean;
}

function sheetXml({ columns, rows = [], footer = null }) {
  const lines = [];
  const widths = columns.map((c) => Math.min(Math.max(String(c.label).length, 8), 50));

  const addRow = (cells, index, bold) => {
    const r = index + 1;
    const xml = cells.map(({ value, type }, i) => {
      const shown = type === 'date' ? 10 : textOf(value ?? '').length;
      widths[i] = Math.min(Math.max(widths[i], shown), 50);
      return cellXml(`${columnLetter(i)}${r}`, value, type, bold);
    });
    lines.push(`<row r="${r}">${xml.join('')}</row>`);
  };

  addRow(columns.map((c) => ({ value: c.label, type: 'text' })), 0, true);
  rows.forEach((row, i) => addRow(columns.map((c) => ({ value: valueOf(c, row), type: c.type })), i + 1, false));
  if (footer) addRow(columns.map((c) => ({ value: valueOf(c, footer), type: c.type })), rows.length + 1, true);

  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w + 2}" customWidth="1"/>`).join('');

  return (
    `${XML_HEAD}<worksheet xmlns="${MAIN_NS}">` +
    // The header row stays in view while scrolling.
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${lines.join('')}</sheetData>` +
    '</worksheet>'
  );
}

const STYLES_XML =
  `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">` +
  '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/**
 * A workbook as a Buffer.
 *
 * @param {Array<{ name: string, columns: Array<{ key: string, label: string, value?: Function, type?: 'date'|'number'|'text' }>, rows: object[], footer?: object }>} sheets
 *   `footer` is one more row, in bold -- a totals line.
 */
function toXlsx(sheets) {
  const taken = new Set();
  const named = sheets.map((sheet, i) => ({ ...sheet, name: sheetName(sheet.name, i, taken) }));

  const files = [
    {
      name: '[Content_Types].xml',
      data:
        `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>'
    },
    {
      name: '_rels/.rels',
      data: `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    {
      name: 'xl/workbook.xml',
      data:
        `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>` +
        named.map((sheet, i) => `<sheet name="${xmlText(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}">` +
        named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${named.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>` +
        '</Relationships>'
    },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...named.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sheet) }))
  ];

  return zip(files);
}

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Sends one sheet -- or several, via `options.sheets` -- as a download.
 * Mirrors csv.sendCsv(res, filename, columns, rows).
 */
function sendXlsx(res, filename, columns, rows, options = {}) {
  const sheets = options.sheets || [{ name: options.sheet || filename.replace(/\.xlsx$/i, ''), columns, rows, footer: options.footer }];
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^a-z0-9._-]/gi, '_')}"`);
  return res.send(toXlsx(sheets));
}

module.exports = { toXlsx, sendXlsx, zip, crc32, dateSerial, columnLetter, XLSX_TYPE };
