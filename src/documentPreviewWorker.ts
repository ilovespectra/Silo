import { isMainThread, parentPort, workerData } from "worker_threads";
import { execFile } from "child_process";
import { unzipSync } from "fflate";
import {
  DocumentPreview,
  MAX_TEXT_BYTES,
  MAX_XML_ENTRY_BYTES,
  MAX_XML_TOTAL_BYTES,
  readPreviewBytes,
  rawDocumentPreview,
  boundedDocumentText,
  extractDocumentPreview,
} from "./documentPreview";

const entityNames: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  reg: "®",
  bull: "•",
};
function decodeEntities(text: string): string {
  // Matches at most 16 characters per entity, never expands DTD entities.
  return text.replace(
    /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{1,16});/g,
    (full, entity: string) => {
      if (entity[0] !== "#") return entityNames[entity] ?? full;
      const code =
        entity[1] === "x"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "�";
    },
  );
}

/** Linear markup scanner; ignores attributes, DTDs, scripts and styles. No HTML execution. */
function xmlText(xml: string): string {
  const chunks: string[] = [];
  let i = 0,
    suppress: string | undefined;
  while (i < xml.length) {
    if (xml[i] !== "<") {
      const end = xml.indexOf("<", i);
      const stop = end < 0 ? xml.length : end;
      if (!suppress) chunks.push(decodeEntities(xml.slice(i, stop)));
      i = stop;
      continue;
    }
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      if (!suppress) chunks.push(xml.slice(i + 9, end < 0 ? xml.length : end));
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    let end = i + 1,
      quote = "",
      bracketDepth = 0;
    while (end < xml.length) {
      const ch = xml[end];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "[") bracketDepth++;
      else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      else if (ch === ">" && !bracketDepth) break;
      end++;
    }
    const tag = xml.slice(i + 1, Math.min(end, i + 256)).trim();
    const closing = tag.startsWith("/");
    const qualified = tag.replace(/^\//, "").split(/[\s/]/, 1)[0].toLowerCase();
    const name = qualified.split(":").pop()!;
    if (name === "script" || name === "style") {
      if (closing && suppress === name) suppress = undefined;
      else if (!closing) suppress = name;
    } else if (!suppress) {
      if (
        name === "tab" ||
        (name === "table-cell" && closing) ||
        (name === "c" && closing)
      )
        chunks.push("\t");
      else if (name === "s" && !closing) chunks.push(" ");
      else if (
        ["br", "line-break"].includes(name) ||
        (closing &&
          [
            "p",
            "h",
            "div",
            "li",
            "tr",
            "row",
            "table-row",
            "h1",
            "h2",
            "h3",
          ].includes(name))
      )
        chunks.push("\n");
    }
    i = end + 1;
  }
  return chunks
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function selectedEntry(name: string, ext: string): boolean {
  if (name.includes("..") || name.startsWith("/") || name.includes("\\"))
    return false;
  if (ext === ".docx")
    return (
      name === "word/document.xml" ||
      /^word\/(header|footer)\d+\.xml$/.test(name) ||
      name === "word/footnotes.xml" ||
      name === "word/endnotes.xml"
    );
  if ([".odt", ".ods", ".odp"].includes(ext)) return name === "content.xml";
  if (ext === ".pptx")
    return /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(name);
  if (ext === ".xlsx")
    return (
      name === "xl/sharedStrings.xml" ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
    );
  if (ext === ".epub") return /\.(xhtml|html|htm)$/i.test(name);
  return false;
}

function safeXmlEntries(
  data: Buffer,
  ext: string,
): { entries: Record<string, Uint8Array>; skipped: boolean } {
  let total = 0,
    count = 0,
    skipped = false;
  const entries = unzipSync(data, {
    filter: (entry) => {
      if (!selectedEntry(entry.name, ext)) return false;
      if (
        entry.originalSize > MAX_XML_ENTRY_BYTES ||
        total + entry.originalSize > MAX_XML_TOTAL_BYTES ||
        ++count > 128
      ) {
        skipped = true;
        return false;
      }
      total += entry.originalSize;
      return true;
    },
  });
  // Recheck actual output; do not trust archive metadata alone.
  total = 0;
  for (const value of Object.values(entries)) {
    total += value.length;
    if (value.length > MAX_XML_ENTRY_BYTES || total > MAX_XML_TOTAL_BYTES)
      throw new Error("Archive output limit");
  }
  return { entries, skipped };
}

function spreadsheetText(entries: Record<string, Uint8Array>): string {
  const sharedXml = entries["xl/sharedStrings.xml"];
  const shared: string[] = [];
  if (sharedXml) {
    const xml = Buffer.from(sharedXml).toString("utf8");
    // Fixed literal delimiters and indexOf scans avoid pathological XML regexes.
    let start = 0;
    while ((start = xml.indexOf("<si", start)) >= 0) {
      const open = xml.indexOf(">", start),
        end = xml.indexOf("</si>", open);
      if (open < 0 || end < 0) break;
      shared.push(xmlText(xml.slice(open + 1, end)));
      start = end + 5;
    }
  }
  const sheets: string[] = [];
  for (const name of Object.keys(entries)
    .filter((n) => n.startsWith("xl/worksheets/"))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
    const xml = Buffer.from(entries[name]).toString("utf8");
    const lines: string[] = [];
    let i = 0;
    while ((i = xml.indexOf("<row", i)) >= 0) {
      const start = xml.indexOf(">", i),
        end = xml.indexOf("</row>", start);
      if (start < 0 || end < 0) break;
      const row = xml.slice(start + 1, end),
        cells: string[] = [];
      let c = 0;
      while ((c = row.indexOf("<c", c)) >= 0) {
        const open = row.indexOf(">", c),
          close = row.indexOf("</c>", open);
        if (open < 0 || close < 0) break;
        const tag = row.slice(c, open + 1),
          body = row.slice(open + 1, close);
        const v = body.indexOf("<v>"),
          vend = body.indexOf("</v>", v + 3);
        const value = v >= 0 && vend >= 0 ? body.slice(v + 3, vend) : "";
        cells.push(
          /\bt\s*=\s*["']s["']/.test(tag)
            ? (shared[Number(value)] ?? "[missing shared string]")
            : xmlText(body),
        );
        c = close + 4;
      }
      lines.push(cells.join("\t"));
      i = end + 6;
    }
    sheets.push(`${name}\n${lines.join("\n")}`);
  }
  return sheets.join("\n\n");
}

async function textutilPreview(
  localPath: string,
  data: Buffer,
  ext: string,
): Promise<DocumentPreview> {
  if (process.platform !== "darwin")
    return rawDocumentPreview(
      localPath,
      "Legacy DOC/RTF extraction requires macOS textutil; showing raw bytes.",
    );
  return new Promise((resolve) => {
    const child = execFile(
      "/usr/bin/textutil",
      [
        "-convert",
        "txt",
        "-stdin",
        "-format",
        ext.slice(1),
        "-stdout",
        "-encoding",
        "UTF-8",
      ],
      { timeout: 10000, maxBuffer: MAX_TEXT_BYTES, encoding: "utf8" },
      (error, stdout) => {
        // textutil uses a capped pipe rather than producing an unbounded file.
        if (error)
          void rawDocumentPreview(
            localPath,
            "macOS textutil failed or exceeded its output/time limit; showing raw bytes.",
          ).then(resolve);
        else resolve(boundedDocumentText(stdout));
      },
    );
    // Feed the bounded snapshot, not a path that could grow while textutil reads it.
    child.stdin?.on("error", () => {
      /* A closed conversion pipe is handled by the callback. */
    });
    child.stdin?.end(data);
  });
}

export async function convertDocument(
  localPath: string,
  ext: string,
): Promise<DocumentPreview> {
  try {
    const limit = ext === ".pdf" ? 20 * 1024 * 1024 : 10 * 1024 * 1024;
    const { data, truncated } = await readPreviewBytes(localPath, limit);
    if (truncated)
      return rawDocumentPreview(
        localPath,
        `Document exceeds the ${limit / 1024 / 1024} MiB conversion input limit; showing raw bytes.`,
      );
    if (ext === ".doc" || ext === ".rtf")
      return textutilPreview(localPath, data, ext);
    if (ext === ".pdf") {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: new Uint8Array(data) });
      try {
        const result = await parser.getText({ first: 20 });
        return boundedDocumentText(
          result.text,
          "PDF text only (no OCR); at most the first 20 pages.",
          result.total > 20,
        );
      } finally {
        await parser.destroy();
      }
    }
    const { entries, skipped } = safeXmlEntries(data, ext);
    if (
      !Object.keys(entries).length ||
      (ext === ".docx" && !entries["word/document.xml"])
    ) {
      return rawDocumentPreview(
        localPath,
        "No safe readable document entries were found; showing raw bytes.",
      );
    }
    if (ext === ".docx") {
      if (skipped)
        return rawDocumentPreview(
          localPath,
          "DOCX XML exceeds safe extraction limits; showing raw bytes.",
        );
      // Repack only checked entries: mammoth cannot inflate unrelated zip members.
      const { zipSync } = await import("fflate");
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(zipSync(entries)),
      });
      return boundedDocumentText(
        result.value,
        "DOCX text only; images and layout are omitted.",
      );
    }
    const text =
      ext === ".xlsx"
        ? spreadsheetText(entries)
        : Object.keys(entries)
            .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
            .map((name) => xmlText(Buffer.from(entries[name]).toString("utf8")))
            .join("\n\n");
    return boundedDocumentText(
      text,
      [
        "Text only; document layout and formulas are not rendered.",
        ext === ".epub"
          ? "EPUB content is shown in entry-name order, not necessarily reading order."
          : "",
        skipped ? "Oversized or excess XML entries were omitted." : "",
      ]
        .filter(Boolean)
        .join(" "),
      skipped,
    );
  } catch {
    return rawDocumentPreview(
      localPath,
      "Document conversion failed or the document is invalid/encrypted; showing raw bytes.",
    );
  }
}

if (!isMainThread && parentPort) {
  const { localPath, originalName, mimeType } = workerData;
  void extractDocumentPreview(localPath, originalName, mimeType)
    .catch(() =>
      rawDocumentPreview(
        localPath,
        "Document extraction failed; showing raw bytes.",
      ),
    )
    .then((preview) => parentPort!.postMessage(preview));
}
