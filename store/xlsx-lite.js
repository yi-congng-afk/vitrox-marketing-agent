// A small Excel (.xlsx) writer: one or more sheets of plain rows, a bold
// header row, sensible column widths. No outside library: an .xlsx file is a
// zip of a few XML files, written here uncompressed ("stored").
// Works in the browser (window.XlsxLite) and in Node (module.exports) for tests.
(function (root) {
  'use strict';

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8(text) {
    return new TextEncoder().encode(text);
  }

  // files: [{ name, text }] -> Uint8Array of a zip archive (no compression).
  function zip(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
    const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
    for (const file of files) {
      const name = utf8(file.name);
      const data = utf8(file.text);
      const crc = crc32(data);
      const local = new Uint8Array([
        ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(DOS_DATE),
        ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
      ]);
      chunks.push(local, name, data);
      central.push(
        new Uint8Array([
          ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(DOS_DATE),
          ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0),
          ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
        ]),
        name
      );
      offset += local.length + name.length + data.length;
    }
    const centralSize = central.reduce((sum, c) => sum + c.length, 0);
    const end = new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
      ...u32(centralSize), ...u32(offset), ...u16(0),
    ]);
    const all = chunks.concat(central, [end]);
    const out = new Uint8Array(all.reduce((sum, c) => sum + c.length, 0));
    let pos = 0;
    for (const c of all) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  // Characters XML 1.0 does not allow are dropped; the rest are escaped.
  function xmlText(value) {
    return String(value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function columnName(index) {
    let name = '';
    let n = index + 1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      name = String.fromCharCode(65 + rem) + name;
      n = Math.floor((n - 1) / 26);
    }
    return name;
  }

  function sheetName(name, used) {
    let clean = String(name || 'Sheet').replace(/[\[\]:*?\/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let candidate = clean;
    let i = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${clean.slice(0, 27)} (${i++})`;
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function sheetXml(rows) {
    const widths = [];
    rows.forEach((row) =>
      row.forEach((cell, c) => {
        const len = cell === null || cell === undefined ? 0 : String(cell).length;
        widths[c] = Math.min(60, Math.max(widths[c] || 8, len + 2));
      })
    );
    const cols = widths.length
      ? `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
      : '';
    const body = rows
      .map((row, r) => {
        const cells = row
          .map((cell, c) => {
            const ref = `${columnName(c)}${r + 1}`;
            const style = r === 0 ? ' s="1"' : '';
            if (cell === null || cell === undefined || cell === '') return `<c r="${ref}"${style}/>`;
            if (typeof cell === 'number' && Number.isFinite(cell)) return `<c r="${ref}"${style}><v>${cell}</v></c>`;
            // Text is always stored as text, so nothing can turn into a formula.
            return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlText(cell)}</t></is></c>`;
          })
          .join('');
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join('');
    const freeze = rows.length > 1 ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      freeze +
      cols +
      `<sheetData>${body}</sheetData>` +
      '</worksheet>'
    );
  }

  // sheets: [{ name, rows: [[...], ...] }] (first row = header). Returns Uint8Array.
  function build(sheets) {
    const used = new Set();
    const named = sheets.map((s) => ({ name: sheetName(s.name, used), rows: s.rows }));
    const files = [
      {
        name: '[Content_Types].xml',
        text:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
          '</Types>',
      },
      {
        name: '_rels/.rels',
        text:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      },
      {
        name: 'xl/workbook.xml',
        text:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets>${named.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>` +
          '</workbook>',
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        text:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
          `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          '</Relationships>',
      },
      {
        name: 'xl/styles.xml',
        text:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
          '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
          '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
          '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
          '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
          '</styleSheet>',
      },
    ].concat(named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(s.rows) })));
    return zip(files);
  }

  const api = { build, crc32, columnName };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XlsxLite = api;
})(typeof window !== 'undefined' ? window : this);
