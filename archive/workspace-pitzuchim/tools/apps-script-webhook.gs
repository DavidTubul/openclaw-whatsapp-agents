/**
 * apps-script-webhook.gs — Google Apps Script Web App: the human dashboard for פיצי.
 *
 * One Google Sheet, TWO tabs:
 *   • "שיחות" (Chats)  — every message in/out: who (name+phone), direction, text, time.
 *                        A human scrolls it to see exactly what פיצי wrote and to whom.
 *   • "תיקים" (Cases)  — complaint cases + decisions + status, for fulfillment & oversight.
 *
 * It receives what the bot sends:
 *   { action: "append-chat", row: {...} }       → a row in "שיחות"
 *   { action: "append",  row: {...case...} }     → a row in "תיקים"
 *   { action: "update",  row: {...case...} }     → patch a case row (by id, col A)
 *
 * SETUP (≈5 min, needs David's Google account):
 *   1. Create a Google Sheet (any name, e.g. "פיצי — מעקב").
 *   2. Extensions → Apps Script. Delete the stub, paste this whole file, Save.
 *   3. Set SHEET_ID below to the sheet id (the long string in its URL).
 *   4. Deploy → New deployment → "Web app": Execute as = Me · Who has access = Anyone → Deploy → copy the /exec URL.
 *   5. Put that URL in workspace-pitzuchim/.config/bot.json → sheet.webhook_url, and set sheet.enabled=true.
 *   6. Test:  node tools/sheet-sync.mjs ping      (should print ok:true)
 *      Then:  node tools/sheet-sync.mjs backfill  (loads existing chat history into the Sheet)
 *   The tabs + Hebrew headers are auto-created on first write.
 */

var SHEET_ID = "PUT_YOUR_SHEET_ID_HERE";

var CHATS_TAB = "שיחות";
var CHAT_FIELDS  = ["ts", "conversation", "direction", "name", "phone", "text"];
var CHAT_HEADERS = ["זמן", "שיחה", "כיוון", "שם", "טלפון", "הודעה"];

var CASES_TAB = "תיקים";
var CASE_FIELDS = ["id","created","updated","status","type","customer_name","customer_phone","product",
  "complaint","expiry_read","days_to_expiry","authentic","decision_reason","packages","shipping","media","notes"];
var CASE_HEADERS = ["מזהה","נוצר","עודכן","סטטוס","סוג","שם לקוח","טלפון","מוצר",
  "תלונה","תוקף שנקרא","ימים לתוקף","אותנטי","נימוק החלטה","חבילות","משלוח","מדיה","הערות"];

function tab_(name, headers) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) { sh.appendRow(headers); sh.setFrozenRows(1); }
  return sh;
}

function rowValues_(row, fields) {
  return fields.map(function (f) {
    var v = row[f];
    if (v === null || v === undefined) return "";
    return (typeof v === "object") ? JSON.stringify(v) : v;
  });
}

function findRowById_(sh, id) {
  var n = Math.max(0, sh.getLastRow() - 1);
  if (n === 0) return -1;
  var ids = sh.getRange(2, 1, n, 1).getValues();
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return -1;
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action, row = body.row || {};

    if (action === "append-chat") {
      tab_(CHATS_TAB, CHAT_HEADERS).appendRow(rowValues_(row, CHAT_FIELDS));
      return json_({ ok: true, action: action });
    }
    if (action === "append") {
      tab_(CASES_TAB, CASE_HEADERS).appendRow(rowValues_(row, CASE_FIELDS));
      return json_({ ok: true, action: action, id: row.id });
    }
    if (action === "update") {
      var sh = tab_(CASES_TAB, CASE_HEADERS);
      var r = findRowById_(sh, row.id);
      if (r < 0) { sh.appendRow(rowValues_(row, CASE_FIELDS)); return json_({ ok: true, action: "append-fallback", id: row.id }); }
      sh.getRange(r, 1, 1, CASE_FIELDS.length).setValues([rowValues_(row, CASE_FIELDS)]);
      return json_({ ok: true, action: action, id: row.id, row_number: r });
    }
    return json_({ ok: false, error: "unknown action: " + action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doGet() { return json_({ ok: true, service: "pitzi-dashboard", tabs: [CHATS_TAB, CASES_TAB] }); }

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
