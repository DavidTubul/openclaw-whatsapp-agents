import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeQP, decodeMimeBody, parseEnvFile, loadEnvFile } from "./gmail.mjs";

// --- decodeQP ------------------------------------------------------------

test("decodeQP strips soft line-breaks and decodes =HH hex escapes to raw bytes", () => {
  // =C3=A9 → the two raw bytes 0xC3 0xA9 (UTF-8 for é); decodeQP emits latin1 chars, the
  // caller re-decodes as UTF-8 (see decodeMimeBody). Verify the exact charcodes here.
  const out = decodeQP("Caf=C3=A9");
  assert.equal(out, "CafÃ©");
  assert.equal(Buffer.from(out, "binary").toString("utf8"), "Café");
  assert.equal(decodeQP("a=\r\nb"), "ab");     // CRLF soft break removed
  assert.equal(decodeQP("a=\nb"), "ab");        // LF-only soft break
  assert.equal(decodeQP("plain text"), "plain text");
});

// --- decodeMimeBody ------------------------------------------------------

test("decodeMimeBody decodes quoted-printable Hebrew UTF-8", () => {
  const hebrew = "שלום עולם"; // encode as QP
  const qp = Buffer.from(hebrew, "utf8").toString("binary")
    .replace(/[^\x20-\x7e]/g, (c) => "=" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  const raw = [
    'Content-Type: multipart/alternative; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    qp,
    "--B--",
    "",
  ].join("\r\n");
  assert.equal(decodeMimeBody(raw), hebrew);
});

test("decodeMimeBody decodes base64 (Hebrew)", () => {
  const hebrew = "עברית בבסיס64";
  const body = Buffer.from(hebrew, "utf8").toString("base64");
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
  assert.equal(decodeMimeBody(raw), hebrew);
});

test("decodeMimeBody falls back to text/html with tags stripped when no plain part", () => {
  const raw = [
    'Content-Type: multipart/alternative; boundary="B"',
    "",
    "--B",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body><p>שלום&nbsp;<b>עולם</b></p></body></html>",
    "--B--",
    "",
  ].join("\r\n");
  assert.equal(decodeMimeBody(raw), "שלום עולם");
});

test("decodeMimeBody prefers the plain part over html when both present", () => {
  const raw = [
    'Content-Type: multipart/alternative; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "PLAIN wins",
    "--B",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>HTML loses here entirely</p>",
    "--B--",
    "",
  ].join("\r\n");
  assert.equal(decodeMimeBody(raw), "PLAIN wins");
});

// --- parseEnvFile --------------------------------------------------------

test("parseEnvFile: KEY=VALUE, verbatim spaces/=, skips blank/comment/lowercase, CRLF, nullish", () => {
  assert.deepEqual(parseEnvFile("GMAIL_USER=me@gmail.com\nGMAIL_APP_PASSWORD=abcd efgh ijkl"), {
    GMAIL_USER: "me@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl",
  });
  assert.equal(parseEnvFile("TOKEN=a=b=c").TOKEN, "a=b=c");
  assert.deepEqual(parseEnvFile("\n# c\nlower=no\nA=1\n   \n"), { A: "1" });
  assert.deepEqual(parseEnvFile("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
  assert.deepEqual(parseEnvFile(null), {});
  assert.deepEqual(parseEnvFile(undefined), {});
});

// --- loadEnvFile (explicit precedence: FILE wins) ------------------------

test("loadEnvFile: file value OVERWRITES inherited process.env (the 2026-07-15 collision fix)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gmail-env-"));
  const K = "GMAIL_USER_TEST_LOADENV"; // UPPER_SNAKE, no digits (parseEnvFile keys are [A-Z_]+)
  try {
    process.env[K] = "inherited@personal.com"; // simulate the systemd-inherited personal creds
    const p = join(dir, "bot.env");
    writeFileSync(p, `${K}=bot@digit.com\n`);
    const applied = loadEnvFile(p);
    assert.deepEqual(applied, { [K]: "bot@digit.com" });
    assert.equal(process.env[K], "bot@digit.com"); // FILE won
  } finally {
    delete process.env[K];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnvFile: keys absent from the file keep their inherited env value (fallback)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gmail-env-"));
  const KEEP = "GMAIL_KEEP_TEST_KEY";
  const SET = "GMAIL_SET_TEST_KEY";
  try {
    process.env[KEEP] = "kept";
    writeFileSync(join(dir, "bot.env"), `${SET}=fromfile\n`);
    loadEnvFile(join(dir, "bot.env"));
    assert.equal(process.env[KEEP], "kept");      // untouched
    assert.equal(process.env[SET], "fromfile");
  } finally {
    delete process.env[KEEP];
    delete process.env[SET];
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnvFile: missing file is a no-op returning {}", () => {
  assert.deepEqual(loadEnvFile("/no/such/env/file/xyz.env"), {});
});
