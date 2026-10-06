/* Run after npx tsc: node test/runDocumentPreviewTests.cjs. No app/Electron needed. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { zipSync, strToU8 } = require("fflate");
const {
  getDocumentPreview,
  documentLanguage,
  isDocumentPreviewFile,
  MAX_TEXT_BYTES,
  MAX_RAW_BYTES,
} = require("../electron-dist/documentPreview");

async function main() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "document-preview-test-"),
  );
  let checks = 0;
  async function preview(name, bytes, originalName, mimeType) {
    const file = path.join(directory, name);
    await fs.writeFile(file, bytes);
    return getDocumentPreview(file, originalName, mimeType);
  }
  function check(test) {
    test();
    checks++;
  }
  function zip(entries) {
    return Buffer.from(
      zipSync(
        Object.fromEntries(
          Object.entries(entries).map(([name, value]) => [
            name,
            strToU8(value),
          ]),
        ),
      ),
    );
  }
  try {
    let p = await preview("README", "Plain readable text\nNo extension.");
    check(() => {
      assert.equal(p.kind, "text");
      assert.equal(p.text, "Plain readable text\nNo extension.");
      assert.equal(p.truncated, false);
    });
    p = await preview(
      "utf8.txt",
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("Hello café 日本語"),
      ]),
    );
    check(() => {
      assert.equal(p.text, "Hello café 日本語");
      assert.equal(p.encoding, "utf-8");
    });
    const unicode = "Hello UTF-16\n日本語 😀";
    const le = Buffer.from(unicode, "utf16le");
    p = await preview("le.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), le]));
    check(() => {
      assert.equal(p.text, unicode);
      assert.equal(p.encoding, "utf-16le");
    });
    p = await preview(
      "be.txt",
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(le).swap16()]),
    );
    check(() => {
      assert.equal(p.text, unicode);
      assert.equal(p.encoding, "utf-16be");
    });
    p = await preview(
      "no-bom.txt",
      Buffer.from("A sane UTF16 text file", "utf16le"),
    );
    check(() => {
      assert.equal(p.text, "A sane UTF16 text file");
      assert.equal(p.encoding, "utf-16le");
    });
    p = await preview("cache.tmp", "const value: number = 42;", "source.ts");
    check(() => {
      assert.equal(p.kind, "code");
      assert.equal(p.language, "typescript");
    });
    p = await preview("Dockerfile", "FROM node:22\n");
    check(() => {
      assert.equal(p.kind, "code");
      assert.equal(p.language, "dockerfile");
    });
    check(() => {
      const hljs = require("highlight.js");
      for (const name of [
        "a.js",
        "a.jsx",
        "a.tsx",
        "a.py",
        "a.rs",
        "a.go",
        "a.c",
        "a.cpp",
        "a.java",
        "a.swift",
        "a.sql",
        "a.sh",
        "a.json",
        "a.yaml",
        "a.xml",
        "a.html",
        "a.css",
        "a.ini",
        "Dockerfile",
        ".env",
        "a.kt",
        "a.wat",
      ]) {
        assert.ok(hljs.getLanguage(documentLanguage(name)), name);
        assert.ok(isDocumentPreviewFile(name));
      }
    });
    p = await preview("doc.md", "# Heading\n<script>alert(1)</script>");
    check(() => {
      assert.equal(p.kind, "markdown");
      assert.ok(p.text.includes("<script>"));
    });
    p = await preview(
      "data.csv",
      'name,value,note\r\n"Smith, Jane","a""b","line1\nline2"\r\nlast,,',
    );
    check(() => {
      assert.equal(p.kind, "table");
      assert.deepEqual(p.rows, [
        ["name", "value", "note"],
        ["Smith, Jane", 'a"b', "line1\nline2"],
        ["last", "", ""],
      ]);
    });
    p = await preview("data.tsv", 'a\tb\n"one\ttwo"\tthree\n');
    check(() =>
      assert.deepEqual(p.rows, [
        ["a", "b"],
        ["one\ttwo", "three"],
      ]),
    );
    p = await preview("bad.csv", '"unclosed');
    check(() => {
      assert.equal(p.kind, "text");
      assert.match(p.notice, /Malformed/);
    });
    p = await preview("binary.txt", Buffer.from([0, 1, 2, 0x41, 0xff]));
    check(() => {
      assert.equal(p.kind, "binary");
      assert.match(p.text, /00 01 02 41 ff/);
      assert.match(p.text, /\|\.\.\.A\.\|/);
    });
    p = await preview("invalid-utf8", Buffer.from([0x61, 0xc3, 0x28]));
    check(() => assert.equal(p.kind, "binary"));
    p = await preview("archive.zip", Buffer.from("some ASCII bytes"));
    check(() => assert.equal(p.kind, "binary"));
    p = await preview("large.txt", "x".repeat(MAX_TEXT_BYTES + 100));
    check(() => {
      assert.equal(p.truncated, true);
      assert.equal(Buffer.byteLength(p.text), MAX_TEXT_BYTES);
    });
    p = await preview(
      "boundary.txt",
      Buffer.concat([
        Buffer.alloc(MAX_TEXT_BYTES - 1, 0x61),
        Buffer.from("😀 more"),
      ]),
    );
    check(() => {
      assert.equal(p.kind, "text");
      assert.equal(p.truncated, true);
      assert.ok(!p.text.includes("�"));
    });
    p = await preview("raw.bin", Buffer.alloc(MAX_RAW_BYTES + 10, 0x41));
    check(() => {
      assert.equal(p.truncated, true);
      assert.equal(p.text.split("\n").length, MAX_RAW_BYTES / 16);
    });
    p = await preview(
      "small.docx",
      zip({
        "[Content_Types].xml":
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "word/document.xml":
          '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello DOCX &amp; friends</w:t></w:r></w:p></w:body></w:document>',
        "ignored.bin": "unrelated bytes",
      }),
    );
    check(() => {
      assert.equal(p.kind, "document", p.notice);
      assert.match(p.text, /Hello DOCX & friends/);
      assert.ok(!p.text.includes("<w:"));
    });
    p = await preview(
      "small.odt",
      zip({
        "content.xml":
          '<office:document xmlns:office="urn:office" xmlns:text="urn:text"><text:p>Hello &amp; &#x1F600;</text:p><text:p>Second paragraph</text:p></office:document>',
        "styles.xml": "<style>NOT CONTENT</style>",
      }),
    );
    check(() => {
      assert.equal(p.kind, "document");
      assert.equal(p.text, "Hello & 😀\nSecond paragraph");
    });
    p = await preview(
      "mime.tmp",
      zip({ "content.xml": "<p>MIME recognized ODT</p>" }),
      undefined,
      "application/vnd.oasis.opendocument.text",
    );
    check(() => {
      assert.equal(p.kind, "document");
      assert.equal(p.text, "MIME recognized ODT");
    });
    p = await preview(
      "safe.odp",
      zip({
        "content.xml":
          "<p>Visible</p><script>hidden()</script><style>hidden{}</style><p>End</p>",
      }),
    );
    check(() => {
      assert.equal(p.text, "Visible\nEnd");
      assert.ok(!p.text.includes("hidden"));
    });
    p = await preview(
      "small.xlsx",
      zip({
        "xl/sharedStrings.xml": "<sst><si><t>Hello &amp; world</t></si></sst>",
        "xl/worksheets/sheet1.xml":
          '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>42</v></c><c t="inlineStr"><is><t>Inline</t></is></c></row></sheetData></worksheet>',
      }),
    );
    check(() => {
      assert.equal(p.kind, "document");
      assert.match(p.text, /Hello & world\t42\tInline/);
    });
    p = await preview(
      "small.epub",
      zip({
        "OEBPS/chapter.xhtml":
          "<html><head><style>hidden</style></head><body><h1>Title</h1><p>Book &amp; text</p></body></html>",
      }),
    );
    check(() => {
      assert.equal(p.kind, "document");
      assert.match(p.text, /Title\nBook & text/);
      assert.match(p.notice, /entry-name order/);
    });
    const PDFDocument = require("pdfkit");
    const pdf = await new Promise((resolve, reject) => {
      const document = new PDFDocument({ autoFirstPage: false });
      const chunks = [];
      document.on("data", (chunk) => chunks.push(chunk));
      document.on("end", () => resolve(Buffer.concat(chunks)));
      document.on("error", reject);
      for (let i = 1; i <= 22; i++)
        document.addPage().text(`PDF page ${i} clean text`);
      document.end();
    });
    p = await preview("small.pdf", pdf);
    check(() => {
      assert.equal(p.kind, "document", p.notice);
      assert.match(p.text, /PDF page 1 clean text/);
      assert.ok(!p.text.includes("PDF page 21 clean text"));
      assert.equal(p.truncated, true);
    });
    p = await preview(
      "small.rtf",
      "{\\rtf1\\ansi Hello \\b bold\\b0  text\\par Second line}",
    );
    check(() => {
      if (process.platform === "darwin") {
        assert.equal(p.kind, "document", p.notice);
        assert.match(p.text, /Hello bold text/);
        assert.ok(!p.text.includes("\\rtf"));
      } else {
        assert.equal(p.kind, "binary");
        assert.match(p.notice, /macOS/);
      }
    });
    p = await preview(
      "limited.odt",
      zip({ "content.xml": `<p>${"x".repeat(2 * 1024 * 1024)}</p>` }),
    );
    check(() => {
      assert.equal(p.kind, "binary");
      assert.match(p.notice, /safe readable/);
    });
    p = await preview("corrupt.docx", Buffer.from("not a ZIP document"));
    check(() => {
      assert.equal(p.kind, "binary");
      assert.match(p.notice, /failed|entries/);
    });
    p = await getDocumentPreview(path.join(directory, "missing"));
    check(() => {
      assert.equal(p.kind, "binary");
      assert.match(p.notice, /could not be read/);
    });
    const parallel = await Promise.all(
      Array.from({ length: 6 }, () =>
        getDocumentPreview(path.join(directory, "README")),
      ),
    );
    check(() => assert.ok(parallel.every((result) => result.kind === "text")));
    console.log(`Document preview: ${checks} checks passed.`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
