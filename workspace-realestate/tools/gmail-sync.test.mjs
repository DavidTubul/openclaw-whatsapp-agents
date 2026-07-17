import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeMimeBody,
  renderMessageMd,
  messageFileName,
  computePending,
  renderIndex,
  loadState,
  saveState,
  loadAllMessages,
  groupByThread,
  parseEnvFile,
  pickAllMailPath,
  computeAlertDecision,
  isDocumentAttachment,
  isAttachmentTooLarge,
  attachmentExtension,
  sanitizeAttachmentName,
  attachmentFileName,
  renderAttachmentsIndex,
  ATTACHMENT_MAX_BYTES,
} from "./lib/mail-core.mjs";

// (a) MIME decode — quoted-printable, base64, and html-fallback.
test("decodeMimeBody decodes quoted-printable UTF-8", () => {
  const raw = [
    'Content-Type: multipart/alternative; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Caf=C3=A9 au lait",
    "--B--",
    "",
  ].join("\r\n");
  assert.equal(decodeMimeBody(raw), "Café au lait");
});

test("decodeMimeBody decodes base64", () => {
  const body = Buffer.from("Base64 body ✓", "utf8").toString("base64");
  const raw = [
    'Content-Type: multipart/alternative; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
    "--B--",
    "",
  ].join("\r\n");
  assert.equal(decodeMimeBody(raw), "Base64 body ✓");
});

test("decodeMimeBody falls back to text/html with tags stripped", () => {
  const raw = [
    'Content-Type: multipart/alternative; boundary="B"',
    "",
    "--B",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><p>Hello&nbsp;<b>World</b></p></body></html>",
    "--B--",
    "",
  ].join("\r\n");
  assert.equal(decodeMimeBody(raw), "Hello World");
});

// (b) frontmatter render escapes `"` in subject and includes all keys.
test("renderMessageMd emits YAML frontmatter with all keys and escaped quotes", () => {
  const m = {
    uid: 7,
    threadId: "th-1",
    from: "them@x.com",
    fromName: "Them",
    to: "us@gmail.com",
    cc: "",
    subject: 'Re: hi "there"',
    date: "2026-07-15T10:00:00Z",
    attachments: [{ name: "doc.pdf", size: 100 }],
    text: "Body line.",
  };
  const md = renderMessageMd(m);
  assert.match(md, /^---\n/);
  for (const k of ["uid", "thread", "from", "to", "cc", "subject", "date", "attachments"]) {
    assert.match(md, new RegExp(`\\n${k}:`));
  }
  assert.match(md, /subject: "Re: hi \\"there\\""/);
  assert.ok(md.includes("Body line."));
});

// (c) file name derivation.
test("messageFileName derives YYYY-MM-DD--<uid>.md from date", () => {
  assert.equal(messageFileName({ date: "2026-07-15T10:00:00Z", uid: 42 }), "2026-07-15--42.md");
});

// (d) computePending — inbound+new → included; outbound → excluded; alert-once.
test("thread whose last message is inbound and new → pending", () => {
  const threads = new Map([
    [
      "t1",
      [
        { uid: 1, from: "us@gmail.com", date: "2026-07-14T08:00:00Z", subject: "q", file: "a.md" },
        { uid: 9, from: "them@x.com", date: "2026-07-15T09:00:00Z", subject: "q", file: "b.md" },
      ],
    ],
  ]);
  assert.deepEqual(computePending(threads, "us@gmail.com", 5), [
    { file: "messages/b.md", from: "them@x.com", subject: "q", date: "2026-07-15T09:00:00Z" },
  ]);
});

test("thread ending outbound → excluded", () => {
  const threads = new Map([
    [
      "t1",
      [
        { uid: 1, from: "them@x.com", date: "2026-07-14T08:00:00Z", subject: "q", file: "a.md" },
        { uid: 9, from: "US@Gmail.com", date: "2026-07-15T09:00:00Z", subject: "q", file: "b.md" },
      ],
    ],
  ]);
  assert.deepEqual(computePending(threads, "us@gmail.com", 0), []);
});

test("thread ending inbound but uid <= prevLastUid → excluded (alert-once)", () => {
  const threads = new Map([
    [
      "t1",
      [{ uid: 4, from: "them@x.com", date: "2026-07-15T09:00:00Z", subject: "q", file: "b.md" }],
    ],
  ]);
  assert.deepEqual(computePending(threads, "us@gmail.com", 5), []);
});

// (d') computeAlertDecision — the cron-only alert baseline separate from state.lastUid.
test("computeAlertDecision: missing alert-state → baseline reset to maxUid (no alerts)", () => {
  const d = computeAlertDecision(null, "111", 42);
  assert.equal(d.reset, true);
  assert.equal(d.nextAlertedUid, 42);
});

test("computeAlertDecision: uidValidity mismatch → baseline reset to maxUid (no alerts)", () => {
  const d = computeAlertDecision({ uidValidity: "999", alertedUid: 10 }, "111", 42);
  assert.equal(d.reset, true);
  assert.equal(d.nextAlertedUid, 42);
});

test("computeAlertDecision: matching uidValidity → normal path, baseline = stored alertedUid", () => {
  const d = computeAlertDecision({ uidValidity: "111", alertedUid: 30 }, "111", 42);
  assert.equal(d.reset, false);
  assert.equal(d.baselineUid, 30);
  assert.equal(d.nextAlertedUid, 42);
});

test("computeAlertDecision: normal path uses alertedUid, NOT lastUid (alert-once from prev alert run)", () => {
  // Two on-demand syncs advanced state.lastUid to 40; the last alert run stopped at 30.
  // The next --alerts run must alert on 31..42, not be suppressed by lastUid=40.
  const threads = new Map([
    ["t1", [{ uid: 35, from: "them@x.com", date: "2026-07-15T09:00:00Z", subject: "q", file: "m.md" }]],
  ]);
  const d = computeAlertDecision({ uidValidity: "111", alertedUid: 30 }, "111", 42);
  assert.equal(d.reset, false);
  const pending = computePending(threads, "us@gmail.com", d.baselineUid);
  assert.deepEqual(pending, [
    { file: "messages/m.md", from: "them@x.com", subject: "q", date: "2026-07-15T09:00:00Z" },
  ]);
});

// (e) renderIndex — newest-first + replied flag both ways.
test("renderIndex lists newest-first with replied flags", () => {
  const messages = [
    { threadId: "t1", uid: 1, from: "them@x.com", subject: "hi", date: "2026-07-14T08:00:00Z", file: "a.md" },
    { threadId: "t1", uid: 2, from: "us@gmail.com", subject: "re hi", date: "2026-07-15T09:00:00Z", file: "b.md" },
    { threadId: "t2", uid: 3, from: "other@y.com", subject: "yo", date: "2026-07-15T12:00:00Z", file: "c.md" },
  ];
  const idx = renderIndex(messages, "us@gmail.com");
  const lines = idx.trim().split("\n");
  assert.match(lines[0], /Date.*From.*Subject.*Replied.*File/);
  const rows = lines.slice(2);
  // newest-first: c (12:00), b (09:00), a (prev day)
  assert.match(rows[0], /messages\/c\.md/);
  assert.match(rows[0], /✗/); // t2 newest is inbound → not replied
  assert.match(rows[1], /messages\/b\.md/);
  assert.match(rows[1], /✓/); // message itself is outbound
  assert.match(rows[2], /messages\/a\.md/);
  assert.match(rows[2], /✓/); // t1 newest (b) is outbound → replied
});

// (f) state round-trip + missing/corrupt → null.
test("loadState/saveState round-trip, missing and corrupt → null", () => {
  const p = join(mkdtempSync(join(tmpdir(), "mc-state-")), "state.json");
  assert.equal(loadState(p), null); // missing
  const state = { uidValidity: 123, lastUid: 99, lastSyncTs: "2026-07-15T00:00:00Z" };
  saveState(p, state);
  assert.deepEqual(loadState(p), state);
  writeFileSync(p, "not json{");
  assert.equal(loadState(p), null); // corrupt
});

// round-trip: renderMessageMd → loadAllMessages preserves core fields.
test("renderMessageMd → loadAllMessages round-trips uid/thread/from/subject/date/attachments", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-msgs-"));
  const m1 = {
    uid: 7,
    threadId: "th-1",
    from: "them@x.com",
    fromName: "Them",
    to: "us@gmail.com",
    cc: "cc@z.com",
    subject: 'Re: hi "there" | pipes too',
    date: "2026-07-15T10:00:00Z",
    attachments: [{ name: "doc.pdf", size: 100 }],
    text: "Body one.",
  };
  const m2 = {
    uid: 8,
    threadId: "th-2",
    from: "us@gmail.com",
    fromName: "Us",
    to: "them@x.com",
    cc: "",
    subject: "no attachments here",
    date: "2026-07-14T06:30:00Z",
    attachments: [],
    text: "Body two.",
  };
  writeFileSync(join(dir, messageFileName(m1)), renderMessageMd(m1));
  writeFileSync(join(dir, messageFileName(m2)), renderMessageMd(m2));

  const loaded = loadAllMessages(dir);
  assert.equal(loaded.length, 2);

  const b1 = loaded.find((x) => x.uid === 7);
  assert.equal(b1.threadId, m1.threadId);
  assert.equal(b1.from, m1.from);
  assert.equal(b1.subject, m1.subject);
  assert.equal(b1.date, m1.date);
  assert.deepEqual(b1.attachments, m1.attachments);
  assert.equal(b1.file, messageFileName(m1));

  const b2 = loaded.find((x) => x.uid === 8);
  assert.equal(b2.threadId, m2.threadId);
  assert.equal(b2.subject, m2.subject);
  assert.deepEqual(b2.attachments, []);
});

test("loadAllMessages returns [] for a missing directory", () => {
  assert.deepEqual(loadAllMessages("/no/such/dir/xyz"), []);
});

// (g) env-file parsing — the CLI's secrets loader.
test("parseEnvFile parses KEY=VALUE lines into an object", () => {
  const env = parseEnvFile("GMAIL_USER=me@gmail.com\nGMAIL_APP_PASSWORD=abcd");
  assert.deepEqual(env, { GMAIL_USER: "me@gmail.com", GMAIL_APP_PASSWORD: "abcd" });
});

test("parseEnvFile keeps the value verbatim including spaces and '=' signs", () => {
  // Gmail app passwords are displayed as 4 space-separated groups; base64-ish values contain '='.
  const env = parseEnvFile("GMAIL_APP_PASSWORD=abcd efgh ijkl mnop\nTOKEN=a=b=c");
  assert.equal(env.GMAIL_APP_PASSWORD, "abcd efgh ijkl mnop");
  assert.equal(env.TOKEN, "a=b=c");
});

test("parseEnvFile ignores blank lines, comments, and malformed lines", () => {
  const env = parseEnvFile("\n# comment\nlowercase=nope\nGMAIL_USER=me@gmail.com\n   \n");
  assert.deepEqual(env, { GMAIL_USER: "me@gmail.com" });
});

test("parseEnvFile tolerates CRLF and empty/nullish input", () => {
  assert.deepEqual(parseEnvFile("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
  assert.deepEqual(parseEnvFile(""), {});
  assert.deepEqual(parseEnvFile(null), {});
  assert.deepEqual(parseEnvFile(undefined), {});
});

// (h) All Mail mailbox selection — locale-proof via specialUse \All.
test("pickAllMailPath picks the mailbox advertising specialUse \\All", () => {
  const listing = [
    { path: "INBOX" },
    { path: "[Gmail]/כל הדואר", specialUse: "\\All" }, // Hebrew-locale Gmail
    { path: "[Gmail]/פח האשפה", specialUse: "\\Trash" },
  ];
  assert.equal(pickAllMailPath(listing), "[Gmail]/כל הדואר");
});

test("pickAllMailPath falls back to '[Gmail]/All Mail' when nothing advertises \\All", () => {
  assert.equal(pickAllMailPath([{ path: "INBOX" }]), "[Gmail]/All Mail");
  assert.equal(pickAllMailPath([]), "[Gmail]/All Mail");
  assert.equal(pickAllMailPath(null), "[Gmail]/All Mail");
});

// (i) attachment classification — document type filter.
test("isDocumentAttachment accepts pdf/docx/xlsx/csv (case-insensitive)", () => {
  assert.equal(isDocumentAttachment("contract.pdf"), true);
  assert.equal(isDocumentAttachment("Report.DOCX"), true);
  assert.equal(isDocumentAttachment("data.xlsx"), true);
  assert.equal(isDocumentAttachment("export.CSV"), true);
});

test("isDocumentAttachment: last extension wins (foo.docx.pdf → pdf → document)", () => {
  assert.equal(isDocumentAttachment("scan.docx.pdf"), true);
  assert.equal(isDocumentAttachment("archive.pdf.zip"), false); // last ext .zip
});

test("isDocumentAttachment: unnamed/missing name falls back to application/pdf content-type", () => {
  assert.equal(isDocumentAttachment("unnamed", "application/pdf"), true);
  assert.equal(isDocumentAttachment("", "application/pdf"), true);
  assert.equal(isDocumentAttachment(null, "APPLICATION/PDF"), true); // ct case-insensitive
  assert.equal(isDocumentAttachment("unnamed", "application/pdf; name=x"), true); // params tolerated
  assert.equal(isDocumentAttachment("unnamed", "image/png"), false); // non-pdf ct
  assert.equal(isDocumentAttachment("unnamed"), false); // no ct → not a document
});

test("isDocumentAttachment rejects named non-documents even with a pdf content-type", () => {
  assert.equal(isDocumentAttachment("image001.jpg"), false);
  assert.equal(isDocumentAttachment("invite.ics"), false);
  assert.equal(isDocumentAttachment("message_v4.rpmsg"), false);
  assert.equal(isDocumentAttachment("image001.jpg", "application/pdf"), false); // present name wins
  assert.equal(isDocumentAttachment("document", "application/pdf"), false); // named-but-extensionless
});

test("attachmentExtension strips path and lowercases", () => {
  assert.equal(attachmentExtension("a/b/c.PDF"), "pdf");
  assert.equal(attachmentExtension("noext"), "");
  assert.equal(attachmentExtension("unnamed"), "");
});

// (j) size-cap predicate.
test("isAttachmentTooLarge: strictly greater than 30MB", () => {
  assert.equal(isAttachmentTooLarge(ATTACHMENT_MAX_BYTES + 1), true);
  assert.equal(isAttachmentTooLarge(ATTACHMENT_MAX_BYTES), false); // exactly at cap → allowed
  assert.equal(isAttachmentTooLarge(0), false);
  assert.equal(isAttachmentTooLarge("bogus"), false);
});

// (k) filename sanitization.
test("sanitizeAttachmentName defeats path traversal and strips separators", () => {
  assert.equal(sanitizeAttachmentName("../../etc/passwd.pdf"), "passwd.pdf");
  assert.equal(sanitizeAttachmentName("a/b/c.pdf"), "c.pdf");
  assert.equal(sanitizeAttachmentName("..\\win\\evil.docx"), "evil.docx");
  assert.equal(sanitizeAttachmentName("../"), "unnamed"); // nothing usable left
});

test("sanitizeAttachmentName strips control chars, collapses whitespace, drops leading dots", () => {
  assert.equal(sanitizeAttachmentName("a\u0000b\u0007.pdf"), "ab.pdf"); // NUL + BEL removed
  assert.equal(sanitizeAttachmentName("a   b   c.pdf"), "a b c.pdf"); // whitespace collapsed
  assert.equal(sanitizeAttachmentName("...hidden.pdf"), "hidden.pdf");
  assert.equal(sanitizeAttachmentName("   .pdf"), "pdf"); // leading-dot strip then non-empty
});

test("sanitizeAttachmentName preserves Hebrew/Unicode letters", () => {
  assert.equal(sanitizeAttachmentName("חוזה שכירות.pdf"), "חוזה שכירות.pdf");
});

test("sanitizeAttachmentName caps ~120 chars preserving the extension", () => {
  const s = sanitizeAttachmentName("x".repeat(200) + ".pdf");
  assert.equal(s.length, 120);
  assert.ok(s.endsWith(".pdf"));
  // extensionless long name → hard cap at 120
  const noext = sanitizeAttachmentName("y".repeat(200));
  assert.equal(noext.length, 120);
});

test("attachmentFileName is <uid>--<sanitized>", () => {
  assert.equal(attachmentFileName(503, "חוזה.pdf"), "503--חוזה.pdf");
  assert.equal(attachmentFileName(7, "../../evil.pdf"), "7--evil.pdf");
});

// (l) frontmatter round-trip WITH file/skipped fields + legacy entries.
test("renderMessageMd → loadAllMessages round-trips attachment file/skipped fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-att-"));
  const m = {
    uid: 20,
    threadId: "t",
    from: "a@x.com",
    to: "b@x.com",
    cc: "",
    subject: "docs",
    date: "2026-07-10T10:00:00Z",
    attachments: [
      { name: "contract.pdf", size: 1234, file: "attachments/20--contract.pdf" },
      { name: "huge.pdf", size: 99999999, skipped: "too-large" },
      { name: "image001.jpg", size: 500, skipped: "not-document" },
    ],
    text: "Body.",
  };
  writeFileSync(join(dir, messageFileName(m)), renderMessageMd(m));
  const loaded = loadAllMessages(dir);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].attachments, m.attachments);
});

test("legacy attachment entries (name+size only) still parse — backward compatible", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-legacy-"));
  // Hand-write a legacy file exactly as the 563 existing ones look (no file/skipped).
  const legacy = [
    "---",
    "uid: 503",
    'thread: "t1"',
    'from: "help@myfci.com"',
    'to: "r@x.com"',
    'cc: ""',
    'subject: "secure msg"',
    'date: "2026-05-11T16:44:47.000Z"',
    "attachments:",
    '  - name: "message_v4.rpmsg"',
    "    size: 267274",
    "---",
    "",
    "Body text.",
    "",
  ].join("\n");
  writeFileSync(join(dir, "2026-05-11--503.md"), legacy);
  const loaded = loadAllMessages(dir);
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].attachments, [{ name: "message_v4.rpmsg", size: 267274 }]);
  assert.equal("file" in loaded[0].attachments[0], false);
  assert.equal("skipped" in loaded[0].attachments[0], false);
});

// (m) ATTACHMENTS.md rendering — newest-first, pipe escaping, skipped rows.
test("renderAttachmentsIndex: file rows, too-large rows, no row for not-document", () => {
  const messages = [
    {
      date: "2026-05-11T16:44:47.000Z",
      from: "a|b@x.com",
      subject: "deal | plan",
      attachments: [{ name: "c.pdf", size: 10, file: "attachments/503--c.pdf" }],
    },
    {
      date: "2026-06-01T10:00:00.000Z",
      from: "z@x.com",
      subject: "big",
      attachments: [{ name: "huge.pdf", size: 99, skipped: "too-large" }],
    },
    {
      date: "2026-04-01T10:00:00.000Z",
      from: "n@x.com",
      subject: "nope",
      attachments: [{ name: "i.jpg", size: 5, skipped: "not-document" }],
    },
  ];
  const md = renderAttachmentsIndex(messages);
  const lines = md.trim().split("\n");
  assert.match(lines[0], /Documents only.*30MB/); // header note
  assert.match(lines[2], /Date.*From.*Subject.*File/); // table header
  const rows = lines.slice(4);
  assert.equal(rows.length, 2); // not-document produced no row
  // newest-first: June (too-large) before May (file)
  assert.match(rows[0], /2026-06-01/);
  assert.match(rows[0], /huge\.pdf \(skipped >30MB\)/);
  assert.match(rows[1], /2026-05-11/);
  assert.match(rows[1], /attachments\/503--c\.pdf/);
  // pipe escaping in From/Subject
  assert.match(rows[1], /a\\\|b@x\.com/);
  assert.match(rows[1], /deal \\\| plan/);
});

test("renderAttachmentsIndex: empty when nothing downloaded", () => {
  const md = renderAttachmentsIndex([{ date: "2026-01-01", from: "a@x", subject: "s", attachments: [] }]);
  const lines = md.trim().split("\n");
  assert.equal(lines.length, 4); // note + blank + header + separator, no data rows
  assert.equal(lines.slice(4).length, 0); // zero data rows
});

// groupByThread → Map<threadId, m[]>.
test("groupByThread groups messages by threadId", () => {
  const msgs = [
    { threadId: "a", uid: 1 },
    { threadId: "a", uid: 2 },
    { threadId: "b", uid: 3 },
  ];
  const g = groupByThread(msgs);
  assert.ok(g instanceof Map);
  assert.equal(g.size, 2);
  assert.equal(g.get("a").length, 2);
  assert.equal(g.get("b").length, 1);
});
