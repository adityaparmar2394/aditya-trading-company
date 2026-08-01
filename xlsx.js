// server/xlsx.js
// A minimal, dependency-free reader/writer for .xlsx files.
// Supports: single-sheet, plain string/number cells. That covers every
// import/export need in this app without pulling in an npm package.
'use strict';

const zlib = require('node:zlib');

// ---------------- CRC32 ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------------- ZIP writer (stored, no compression) ----------------
function buildZip(files) { // files: [{name, data: Buffer}]
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored, no compression
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  offset += centralBuf.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, end]);
}

// ---------------- ZIP reader ----------------
function readZip(buf) {
  const entries = {};
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Not a valid .xlsx (zip) file');
  const total = buf.readUInt16LE(eocdOffset + 10);
  let centralOffset = buf.readUInt32LE(eocdOffset + 16);

  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(centralOffset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(centralOffset + 10);
    const compSize = buf.readUInt32LE(centralOffset + 20);
    const nameLen = buf.readUInt16LE(centralOffset + 28);
    const extraLen = buf.readUInt16LE(centralOffset + 30);
    const commentLen = buf.readUInt16LE(centralOffset + 32);
    const localHeaderOffset = buf.readUInt32LE(centralOffset + 42);
    const name = buf.toString('utf8', centralOffset + 46, centralOffset + 46 + nameLen);

    const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries[name] = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);

    centralOffset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------------- XML helpers ----------------
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function colName(n) { // 0-indexed -> A, B, ... AA
  let s = '';
  n = n + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ---------------- Public: write a workbook from rows of objects ----------------
// sheets: [{ name, headers: [..], rows: [[..]] }]
function writeXlsx(sheets) {
  const files = [];
  files.push({ name: '[Content_Types].xml', data: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>`) });

  files.push({ name: '_rels/.rels', data: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`) });

  files.push({ name: 'xl/workbook.xml', data: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}
</sheets>
</workbook>`) });

  files.push({ name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
</Relationships>`) });

  sheets.forEach((sheet, si) => {
    const allRows = [sheet.headers, ...sheet.rows];
    const rowsXml = allRows.map((row, ri) => {
      const cells = row.map((val, ci) => {
        const ref = colName(ci) + (ri + 1);
        if (val === null || val === undefined || val === '') return '';
        if (typeof val === 'number' && isFinite(val)) {
          return `<c r="${ref}"><v>${val}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(val)}</t></is></c>`;
      }).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');

    files.push({ name: `xl/worksheets/sheet${si + 1}.xml`, data: Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${rowsXml}</sheetData>
</worksheet>`) });
  });

  return buildZip(files);
}

// ---------------- Public: read the first sheet into rows of arrays ----------------
function readXlsx(buf) {
  const entries = readZip(buf);
  const sheetXml = entries['xl/worksheets/sheet1.xml'];
  if (!sheetXml) throw new Error('No worksheet found in file');

  let sharedStrings = [];
  if (entries['xl/sharedStrings.xml']) {
    const ssXml = entries['xl/sharedStrings.xml'].toString('utf8');
    const siRegex = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRegex.exec(ssXml))) {
      const text = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('');
      sharedStrings.push(unescapeXml(text));
    }
  }

  const xml = sheetXml.toString('utf8');
  const rowRegex = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const rows = [];
  let rm;
  while ((rm = rowRegex.exec(xml))) {
    const rowIdx = parseInt(rm[1], 10) - 1;
    const cellRegex = /<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g;
    const rowData = [];
    let cm;
    while ((cm = cellRegex.exec(rm[2]))) {
      const colLetters = cm[1];
      const attrs = cm[3];
      const inner = cm[4];
      const colIdx = colToIndex(colLetters);
      const typeMatch = attrs.match(/t="([^"]+)"/);
      const type = typeMatch ? typeMatch[1] : 'n';
      let value = '';
      if (type === 's') {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = vMatch ? sharedStrings[parseInt(vMatch[1], 10)] || '' : '';
      } else if (type === 'inlineStr') {
        const tMatch = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        value = tMatch ? unescapeXml(tMatch[1]) : '';
      } else {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        value = vMatch ? vMatch[1] : '';
        if (value !== '' && !isNaN(Number(value))) value = Number(value);
      }
      rowData[colIdx] = value;
    }
    rows[rowIdx] = rowData;
  }
  // Normalize: fill gaps, trim trailing empties
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    out.push(rows[i] ? rows[i].map(v => v === undefined ? '' : v) : []);
  }
  return out.filter(r => r.length > 0);
}

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function unescapeXml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// ---------------- CSV (used as fallback + for simple exports) ----------------
function toCsv(headers, rows) {
  const esc2 = v => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map(esc2).join(',')];
  for (const r of rows) lines.push(r.map(esc2).join(','));
  return lines.join('\r\n');
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

module.exports = { writeXlsx, readXlsx, toCsv, parseCsv };
