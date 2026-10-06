"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.convertDocument = void 0;
const worker_threads_1 = require("worker_threads");
const child_process_1 = require("child_process");
const fflate_1 = require("fflate");
const documentPreview_1 = require("./documentPreview");
const entityNames = {
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
function decodeEntities(text) {
    // Matches at most 16 characters per entity, never expands DTD entities.
    return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{1,16});/g, (full, entity) => {
        if (entity[0] !== "#")
            return entityNames[entity] ?? full;
        const code = entity[1] === "x"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
            ? String.fromCodePoint(code)
            : "�";
    });
}
/** Linear markup scanner; ignores attributes, DTDs, scripts and styles. No HTML execution. */
function xmlText(xml) {
    const chunks = [];
    let i = 0, suppress;
    while (i < xml.length) {
        if (xml[i] !== "<") {
            const end = xml.indexOf("<", i);
            const stop = end < 0 ? xml.length : end;
            if (!suppress)
                chunks.push(decodeEntities(xml.slice(i, stop)));
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
            if (!suppress)
                chunks.push(xml.slice(i + 9, end < 0 ? xml.length : end));
            i = end < 0 ? xml.length : end + 3;
            continue;
        }
        let end = i + 1, quote = "", bracketDepth = 0;
        while (end < xml.length) {
            const ch = xml[end];
            if (quote) {
                if (ch === quote)
                    quote = "";
            }
            else if (ch === '"' || ch === "'")
                quote = ch;
            else if (ch === "[")
                bracketDepth++;
            else if (ch === "]")
                bracketDepth = Math.max(0, bracketDepth - 1);
            else if (ch === ">" && !bracketDepth)
                break;
            end++;
        }
        const tag = xml.slice(i + 1, Math.min(end, i + 256)).trim();
        const closing = tag.startsWith("/");
        const qualified = tag.replace(/^\//, "").split(/[\s/]/, 1)[0].toLowerCase();
        const name = qualified.split(":").pop();
        if (name === "script" || name === "style") {
            if (closing && suppress === name)
                suppress = undefined;
            else if (!closing)
                suppress = name;
        }
        else if (!suppress) {
            if (name === "tab" ||
                (name === "table-cell" && closing) ||
                (name === "c" && closing))
                chunks.push("\t");
            else if (name === "s" && !closing)
                chunks.push(" ");
            else if (["br", "line-break"].includes(name) ||
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
                    ].includes(name)))
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
function selectedEntry(name, ext) {
    if (name.includes("..") || name.startsWith("/") || name.includes("\\"))
        return false;
    if (ext === ".docx")
        return (name === "word/document.xml" ||
            /^word\/(header|footer)\d+\.xml$/.test(name) ||
            name === "word/footnotes.xml" ||
            name === "word/endnotes.xml");
    if ([".odt", ".ods", ".odp"].includes(ext))
        return name === "content.xml";
    if (ext === ".pptx")
        return /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(name);
    if (ext === ".xlsx")
        return (name === "xl/sharedStrings.xml" ||
            /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
    if (ext === ".epub")
        return /\.(xhtml|html|htm)$/i.test(name);
    return false;
}
function safeXmlEntries(data, ext) {
    let total = 0, count = 0, skipped = false;
    const entries = (0, fflate_1.unzipSync)(data, {
        filter: (entry) => {
            if (!selectedEntry(entry.name, ext))
                return false;
            if (entry.originalSize > documentPreview_1.MAX_XML_ENTRY_BYTES ||
                total + entry.originalSize > documentPreview_1.MAX_XML_TOTAL_BYTES ||
                ++count > 128) {
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
        if (value.length > documentPreview_1.MAX_XML_ENTRY_BYTES || total > documentPreview_1.MAX_XML_TOTAL_BYTES)
            throw new Error("Archive output limit");
    }
    return { entries, skipped };
}
function spreadsheetText(entries) {
    const sharedXml = entries["xl/sharedStrings.xml"];
    const shared = [];
    if (sharedXml) {
        const xml = Buffer.from(sharedXml).toString("utf8");
        // Fixed literal delimiters and indexOf scans avoid pathological XML regexes.
        let start = 0;
        while ((start = xml.indexOf("<si", start)) >= 0) {
            const open = xml.indexOf(">", start), end = xml.indexOf("</si>", open);
            if (open < 0 || end < 0)
                break;
            shared.push(xmlText(xml.slice(open + 1, end)));
            start = end + 5;
        }
    }
    const sheets = [];
    for (const name of Object.keys(entries)
        .filter((n) => n.startsWith("xl/worksheets/"))
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
        const xml = Buffer.from(entries[name]).toString("utf8");
        const lines = [];
        let i = 0;
        while ((i = xml.indexOf("<row", i)) >= 0) {
            const start = xml.indexOf(">", i), end = xml.indexOf("</row>", start);
            if (start < 0 || end < 0)
                break;
            const row = xml.slice(start + 1, end), cells = [];
            let c = 0;
            while ((c = row.indexOf("<c", c)) >= 0) {
                const open = row.indexOf(">", c), close = row.indexOf("</c>", open);
                if (open < 0 || close < 0)
                    break;
                const tag = row.slice(c, open + 1), body = row.slice(open + 1, close);
                const v = body.indexOf("<v>"), vend = body.indexOf("</v>", v + 3);
                const value = v >= 0 && vend >= 0 ? body.slice(v + 3, vend) : "";
                cells.push(/\bt\s*=\s*["']s["']/.test(tag)
                    ? (shared[Number(value)] ?? "[missing shared string]")
                    : xmlText(body));
                c = close + 4;
            }
            lines.push(cells.join("\t"));
            i = end + 6;
        }
        sheets.push(`${name}\n${lines.join("\n")}`);
    }
    return sheets.join("\n\n");
}
async function textutilPreview(localPath, data, ext) {
    if (process.platform !== "darwin")
        return (0, documentPreview_1.rawDocumentPreview)(localPath, "Legacy DOC/RTF extraction requires macOS textutil; showing raw bytes.");
    return new Promise((resolve) => {
        const child = (0, child_process_1.execFile)("/usr/bin/textutil", [
            "-convert",
            "txt",
            "-stdin",
            "-format",
            ext.slice(1),
            "-stdout",
            "-encoding",
            "UTF-8",
        ], { timeout: 10000, maxBuffer: documentPreview_1.MAX_TEXT_BYTES, encoding: "utf8" }, (error, stdout) => {
            // textutil uses a capped pipe rather than producing an unbounded file.
            if (error)
                void (0, documentPreview_1.rawDocumentPreview)(localPath, "macOS textutil failed or exceeded its output/time limit; showing raw bytes.").then(resolve);
            else
                resolve((0, documentPreview_1.boundedDocumentText)(stdout));
        });
        // Feed the bounded snapshot, not a path that could grow while textutil reads it.
        child.stdin?.on("error", () => {
            /* A closed conversion pipe is handled by the callback. */
        });
        child.stdin?.end(data);
    });
}
async function convertDocument(localPath, ext) {
    try {
        const limit = ext === ".pdf" ? 20 * 1024 * 1024 : 10 * 1024 * 1024;
        const { data, truncated } = await (0, documentPreview_1.readPreviewBytes)(localPath, limit);
        if (truncated)
            return (0, documentPreview_1.rawDocumentPreview)(localPath, `Document exceeds the ${limit / 1024 / 1024} MiB conversion input limit; showing raw bytes.`);
        if (ext === ".doc" || ext === ".rtf")
            return textutilPreview(localPath, data, ext);
        if (ext === ".pdf") {
            const { PDFParse } = await Promise.resolve().then(() => __importStar(require("pdf-parse")));
            const parser = new PDFParse({ data: new Uint8Array(data) });
            try {
                const result = await parser.getText({ first: 20 });
                return (0, documentPreview_1.boundedDocumentText)(result.text, "PDF text only (no OCR); at most the first 20 pages.", result.total > 20);
            }
            finally {
                await parser.destroy();
            }
        }
        const { entries, skipped } = safeXmlEntries(data, ext);
        if (!Object.keys(entries).length ||
            (ext === ".docx" && !entries["word/document.xml"])) {
            return (0, documentPreview_1.rawDocumentPreview)(localPath, "No safe readable document entries were found; showing raw bytes.");
        }
        if (ext === ".docx") {
            if (skipped)
                return (0, documentPreview_1.rawDocumentPreview)(localPath, "DOCX XML exceeds safe extraction limits; showing raw bytes.");
            // Repack only checked entries: mammoth cannot inflate unrelated zip members.
            const { zipSync } = await Promise.resolve().then(() => __importStar(require("fflate")));
            const mammoth = await Promise.resolve().then(() => __importStar(require("mammoth")));
            const result = await mammoth.extractRawText({
                buffer: Buffer.from(zipSync(entries)),
            });
            return (0, documentPreview_1.boundedDocumentText)(result.value, "DOCX text only; images and layout are omitted.");
        }
        const text = ext === ".xlsx"
            ? spreadsheetText(entries)
            : Object.keys(entries)
                .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
                .map((name) => xmlText(Buffer.from(entries[name]).toString("utf8")))
                .join("\n\n");
        return (0, documentPreview_1.boundedDocumentText)(text, [
            "Text only; document layout and formulas are not rendered.",
            ext === ".epub"
                ? "EPUB content is shown in entry-name order, not necessarily reading order."
                : "",
            skipped ? "Oversized or excess XML entries were omitted." : "",
        ]
            .filter(Boolean)
            .join(" "), skipped);
    }
    catch {
        return (0, documentPreview_1.rawDocumentPreview)(localPath, "Document conversion failed or the document is invalid/encrypted; showing raw bytes.");
    }
}
exports.convertDocument = convertDocument;
if (!worker_threads_1.isMainThread && worker_threads_1.parentPort) {
    const { localPath, originalName, mimeType } = worker_threads_1.workerData;
    void (0, documentPreview_1.extractDocumentPreview)(localPath, originalName, mimeType)
        .catch(() => (0, documentPreview_1.rawDocumentPreview)(localPath, "Document extraction failed; showing raw bytes."))
        .then((preview) => worker_threads_1.parentPort.postMessage(preview));
}
