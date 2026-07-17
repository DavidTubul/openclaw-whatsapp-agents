/**
 * apps-script-webhook.gs — Google Apps Script Web App: the human dashboard for זורו (quit-smoking coach).
 *
 * One Google Sheet, one tab ("צדק" / Streaks) — the "justice table": every member's clean-day
 * streak, sorted by clean_days descending so the longest-running quitter sits on top.
 *
 * Columns (A:L):
 *   A id · B member_name · C e164 · D quit_date · E clean_days · F longest_streak ·
 *   G total_resets · H last_check · I last_result · J weekly_spend · K money_saved · L updated
 *
 * It receives what the bot sends:
 *   { action: "append", row: {...} } | { action: "append", rows: [{...}] }   → add member row(s)
 *   { action: "update", id: "...", updates: {...} }                          → patch a member by id
 *   { action: "read", filter: { id?, name? }, limit? }                       → read rows
 *   { action: "sort" }                                                       → re-sort by clean_days desc
 *   GET                                                                      → health ping
 *
 * SETUP (≈5 min, needs David's Google account):
 *   1. Create a Google Sheet (any name, e.g. "זורו — מעקב רצף").
 *   2. Extensions → Apps Script. Delete the stub, paste this whole file, Save.
 *   3. Set SHEET_ID below to the sheet id (the long string in its URL).
 *   4. Deploy → New deployment → Type: Web App · Execute as = Me · Who has access = Anyone → Deploy → copy the /exec URL.
 *   5. Put that URL in workspace-quitsmoke/.config/bot.json → sheet.webhook_url, and set sheet.enabled=true.
 *   6. Test:  GET the /exec URL in a browser (should print ok:true). The tab + Hebrew headers are
 *      auto-created on first write.
 */

var SHEET_ID = "PUT_YOUR_SHEET_ID_HERE";

var SHEET_NAME = "צדק"; // the justice table (alias: "Streaks")
var FIELDS  = ["id", "member_name", "e164", "quit_date", "clean_days", "longest_streak", "total_resets", "last_check", "last_result", "weekly_spend", "money_saved", "updated"];
var HEADERS = ["מזהה", "שם", "טלפון", "תאריך הפסקה", "ימים נקיים", "רצף שיא", "סך נפילות", "בדיקה אחרונה", "תוצאה אחרונה", "הוצאה שבועית", "כסף שנחסך", "עודכן"];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var sheet = tab_(SHEET_NAME, HEADERS);

    var action = body.action || 'append';
    var result;
    if (action === 'append')      result = handleAppend(sheet, body);
    else if (action === 'update') result = handleUpdate(sheet, body);
    else if (action === 'read')   result = handleRead(sheet, body);
    else if (action === 'sort')   result = handleSort(sheet);
    else return reply({ ok: false, error: 'Unknown action: ' + action });

    return reply({ ok: true, action: action, ...result });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  return reply({ ok: true, service: 'zorro-streaks-webhook', tab: SHEET_NAME, timestamp: new Date().toISOString() });
}

function tab_(name, headers) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.appendRow(headers); sh.setFrozenRows(1); }
  return sh;
}

function rowValues_(row) {
  return FIELDS.map(function (f) {
    var v = row[f];
    if (f === 'updated' && (v === null || v === undefined || v === '')) return new Date().toISOString().slice(0, 19);
    if (v === null || v === undefined) return '';
    return (typeof v === 'object') ? JSON.stringify(v) : v;
  });
}

function findRowById_(sheet, id) {
  var n = Math.max(0, sheet.getLastRow() - 1);
  if (n === 0) return -1;
  var ids = sheet.getRange(2, 1, n, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

function handleAppend(sheet, body) {
  var rows = body.rows || [body.row];
  if (!Array.isArray(rows) || !rows.length || !rows[0]) throw new Error('Missing rows[]');
  var before = sheet.getLastRow();
  var values = rows.map(function (r) { return rowValues_(r); });
  sheet.getRange(before + 1, 1, values.length, FIELDS.length).setValues(values);
  var sorted = sortSheet(sheet); // keep the justice table sorted after every insert
  return { appended: values.length, first_row: before + 1, sorted: sorted };
}

function handleUpdate(sheet, body) {
  var id = body.id || (body.row && body.row.id);
  if (!id) throw new Error('Missing id');
  // streaks.mjs sends the full updated member as { action:"update", row:{...} } (no separate
  // `updates`). Accept either: explicit `updates`, else treat the whole `row` as the update set.
  var updates = body.updates || body.row || {};
  var row = findRowById_(sheet, id);
  if (row < 0) { // upsert: unknown id → append it
    handleAppend(sheet, { row: Object.assign({ id: id }, updates) });
    return { upserted: true, id: id };
  }
  var colMap = {};
  for (var i = 0; i < FIELDS.length; i++) colMap[FIELDS[i]] = i + 1;
  var updated = [];
  Object.keys(updates).forEach(function (key) {
    var col = colMap[key];
    if (!col) return;
    sheet.getRange(row, col).setValue(updates[key]);
    updated.push(key);
  });
  sheet.getRange(row, colMap.updated).setValue(new Date().toISOString().slice(0, 19));
  // re-sort if the streak length changed (it drives the table order)
  var sorted = updated.indexOf('clean_days') !== -1 ? sortSheet(sheet) : 0;
  return { id: id, row: row, updated: updated, sorted: sorted };
}

function handleRead(sheet, body) {
  var last = sheet.getLastRow();
  if (last < 2) return { count: 0, rows: [] };
  var range = sheet.getRange(2, 1, last - 1, FIELDS.length).getValues();
  var filter = body.filter || {};
  var rows = range.map(function (r, i) {
    var o = { sheet_row: i + 2 };
    for (var j = 0; j < FIELDS.length; j++) o[FIELDS[j]] = r[j];
    return o;
  });
  if (filter.id)   rows = rows.filter(function (r) { return String(r.id) === String(filter.id); });
  if (filter.name) rows = rows.filter(function (r) { return String(r.member_name).toLowerCase().indexOf(String(filter.name).toLowerCase()) !== -1; });
  if (body.limit)  rows = rows.slice(0, body.limit);
  return { count: rows.length, rows: rows };
}

// Sort rows (2 onward) in place by clean_days DESC — the justice table: longest clean streak on top.
// Ties broken by longest_streak DESC. Reused by handleSort and handleAppend.
function sortSheet(sheet) {
  var last = sheet.getLastRow();
  if (last < 3) return 0;
  var range = sheet.getRange(2, 1, last - 1, FIELDS.length);
  var values = range.getValues();
  var cleanCol = FIELDS.indexOf('clean_days');
  var longestCol = FIELDS.indexOf('longest_streak');
  var num = function (v) { var n = Number(v); return isNaN(n) ? -1 : n; };
  values.sort(function (a, b) {
    var byClean = num(b[cleanCol]) - num(a[cleanCol]);
    if (byClean !== 0) return byClean;
    return num(b[longestCol]) - num(a[longestCol]);
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
