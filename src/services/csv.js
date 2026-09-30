// src/services/csv.js
//
// Rows to a CSV Excel opens cleanly: a UTF-8 byte-order mark so accented
// names survive, CRLF line ends, every field quoted when it needs to be,
// and formula characters neutralised so a member called "=HYPERLINK(...)"
// cannot run anything in someone's spreadsheet. A plain negative number is
// left as it is: -40 is a refund, not a formula, and "'-40" would reach the
// sheet as text with the apostrophe showing.

function cell(value) {
  if (value === null || value === undefined) return '';
  let text;
  if (value instanceof Date) text = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {Array<{ key: string, label: string, value?: (row) => any }>} columns
 * @param {Array<object>} rows
 */
function toCsv(columns, rows) {
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => cell(c.value ? c.value(row) : row[c.key])).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

function sendCsv(res, filename, columns, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^a-z0-9._-]/gi, '_')}"`);
  return res.send(toCsv(columns, rows));
}

module.exports = { toCsv, sendCsv };
