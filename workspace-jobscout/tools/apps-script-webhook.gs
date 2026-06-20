// Job Scout — Apps Script Webhook
// Receives POST requests from OpenClaw and updates the "Jobs" sheet.
// Deploy: Deploy → New deployment → Type: Web App → Access: Anyone with the link

const SHEET_NAME = 'Jobs';
const SHEET_ID = '<SHEET_ID>';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) return reply({ ok: false, error: 'Sheet "Jobs" not found' });

    const action = body.action || 'append';
    let result;
    if (action === 'append')        result = handleAppend(sheet, body);
    else if (action === 'update')   result = handleUpdate(sheet, body);
    else if (action === 'read')     result = handleRead(sheet, body);
    else if (action === 'find_by_id') result = handleFindById(sheet, body);
    else if (action === 'sort')     result = handleSort(sheet, body);
    else return reply({ ok: false, error: 'Unknown action: ' + action });

    return reply({ ok: true, ...result });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  return reply({ ok: true, message: 'Job Scout webhook is alive', timestamp: new Date().toISOString() });
}

function handleAppend(sheet, body) {
  const rows = body.rows || [body.row];
  if (!Array.isArray(rows) || !rows.length) throw new Error('Missing rows[]');
  const before = sheet.getLastRow();
  const values = rows.map(r => [
    r.id || '', r.found_at || new Date().toISOString().slice(0, 10),
    r.source || '', r.title || '', r.company || '', r.location || '',
    r.level || '', r.score || '', r.reason || '', r.url || '',
    r.status || '⏳ Pending', r.applied_at || '', r.notes || '',
    r.email_snippet || '', new Date().toISOString().slice(0, 19),
  ]);
  sheet.getRange(before + 1, 1, values.length, 15).setValues(values);
  const sorted = sortSheet(sheet); // keep the sheet sorted after every insert
  return { appended: values.length, first_row: before + 1, sorted };
}

function handleUpdate(sheet, body) {
  const row = body.row;
  if (!row) throw new Error('Missing row number');
  const updates = body.updates || {};
  const colMap = { id:1, found_at:2, source:3, title:4, company:5, location:6, level:7, score:8, reason:9, url:10, status:11, applied_at:12, notes:13, email_snippet:14, updated_at:15 };
  const updated = [];
  Object.keys(updates).forEach(key => {
    const col = colMap[key];
    if (!col) return;
    sheet.getRange(row, col).setValue(updates[key]);
    updated.push(key);
  });
  sheet.getRange(row, 15).setValue(new Date().toISOString().slice(0, 19));
  const sorted = updated.includes('status') ? sortSheet(sheet) : 0; // re-sort only when status changed
  return { row, updated, sorted };
}

function handleRead(sheet, body) {
  const last = sheet.getLastRow();
  if (last < 2) return { rows: [] };
  const range = sheet.getRange(2, 1, last - 1, 15).getValues();
  const filter = body.filter || {};
  let rows = range.map((r, i) => ({
    sheet_row: i + 2,
    id: r[0], found_at: r[1], source: r[2], title: r[3], company: r[4],
    location: r[5], level: r[6], score: r[7], reason: r[8], url: r[9],
    status: r[10], applied_at: r[11], notes: r[12], email_snippet: r[13], updated_at: r[14],
  }));
  if (filter.status)  rows = rows.filter(r => String(r.status).includes(filter.status));
  if (filter.company) rows = rows.filter(r => String(r.company).toLowerCase().includes(filter.company.toLowerCase()));
  if (filter.id)      rows = rows.filter(r => r.id === filter.id);
  if (body.limit)     rows = rows.slice(0, body.limit);
  return { count: rows.length, rows };
}

function handleFindById(sheet, body) {
  const id = body.id;
  if (!id) throw new Error('Missing id');
  const last = sheet.getLastRow();
  if (last < 2) return { found: false };
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return { found: true, row: i + 2 };
  }
  return { found: false };
}

// Sort rows (2 onward) in place by status priority, then by found-date (col B)
// newest-first within each status group. Reused by handleSort and handleAppend.
// Status priority: 🎉 Offer(1) > ⏳ Pending(2) > 📞 Interview(3) > ✅ Applied(4) >
//                  ⛔ Not Interested(5) > ❌ Rejected(6) > anything else(7).
function sortSheet(sheet) {
  const last = sheet.getLastRow();
  if (last < 3) return 0;
  const range = sheet.getRange(2, 1, last - 1, 15);
  const values = range.getValues();
  const priority = (status) => {
    const s = String(status);
    if (s.includes('Offer'))          return 1; // 🎉
    if (s.includes('Pending'))        return 2; // ⏳
    if (s.includes('Interview'))      return 3; // 📞
    if (s.includes('Applied'))        return 4; // ✅
    if (s.includes('Not Interested')) return 5; // ⛔
    if (s.includes('Rejected'))       return 6; // ❌
    return 7;
  };
  const foundTime = (v) => {
    const t = new Date(v).getTime();
    return isNaN(t) ? 0 : t; // unparseable/empty dates sink to the bottom of their group
  };
  values.sort((a, b) => {
    const byStatus = priority(a[10]) - priority(b[10]);
    if (byStatus !== 0) return byStatus;
    return foundTime(b[1]) - foundTime(a[1]); // newest found-date first
  });
  range.setValues(values);
  return values.length;
}

function handleSort(sheet) {
  return { sorted: sortSheet(sheet) };
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
