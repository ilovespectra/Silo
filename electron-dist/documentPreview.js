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
exports.getDocumentPreview = exports.extractDocumentPreview = exports.boundedDocumentText = exports.rawDocumentPreview = exports.readPreviewBytes = exports.isDocumentPreviewFile = exports.documentLanguage = exports.conversionExtensions = exports.MAX_XML_TOTAL_BYTES = exports.MAX_XML_ENTRY_BYTES = exports.MAX_RAW_BYTES = exports.MAX_TEXT_BYTES = void 0;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const worker_threads_1 = require("worker_threads");
const util_1 = require("util");
exports.MAX_TEXT_BYTES = 256 * 1024;
exports.MAX_RAW_BYTES = 8 * 1024;
exports.MAX_XML_ENTRY_BYTES = 2 * 1024 * 1024;
exports.MAX_XML_TOTAL_BYTES = 8 * 1024 * 1024;
exports.conversionExtensions = new Set([
    ".pdf",
    ".docx",
    ".doc",
    ".rtf",
    ".odt",
    ".ods",
    ".odp",
    ".pptx",
    ".xlsx",
    ".epub",
]);
const conversionMimeExtensions = {
    "application/pdf": ".pdf",
    "application/msword": ".doc",
    "application/rtf": ".rtf",
    "text/rtf": ".rtf",
    "application/epub+zip": ".epub",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.oasis.opendocument.text": ".odt",
    "application/vnd.oasis.opendocument.spreadsheet": ".ods",
    "application/vnd.oasis.opendocument.presentation": ".odp",
};
const languages = {};
for (const [language, extensions] of Object.entries({
    javascript: "js mjs cjs jsx",
    typescript: "ts mts cts tsx",
    python: "py pyw pyi",
    rust: "rs",
    go: "go",
    c: "c h",
    cpp: "cc cpp cxx hpp hxx hh",
    java: "java",
    swift: "swift",
    kotlin: "kt kts",
    scala: "scala sc",
    csharp: "cs",
    fsharp: "fs fsx",
    sql: "sql",
    bash: "sh bash zsh fish",
    powershell: "ps1 psm1 psd1",
    dos: "bat cmd",
    json: "json jsonc jsonl ndjson",
    yaml: "yaml yml",
    xml: "xml xsd xsl xslt svg plist csproj html htm xhtml vue svelte",
    css: "css",
    scss: "scss",
    less: "less",
    ini: "ini conf cfg toml properties env",
    ruby: "rb rake gemspec",
    php: "php phtml",
    perl: "pl pm",
    lua: "lua",
    r: "r",
    dart: "dart",
    elixir: "ex exs",
    erlang: "erl hrl",
    haskell: "hs",
    clojure: "clj cljs edn",
    objectivec: "m mm",
    cmake: "cmake",
    makefile: "mk",
    dockerfile: "dockerfile",
    diff: "diff patch",
    latex: "tex sty cls",
    graphql: "graphql gql",
    protobuf: "proto",
    matlab: "matlab",
    vbnet: "vb",
    nginx: "nginx",
    apache: "htaccess",
    wasm: "wat",
})) {
    for (const extension of extensions.split(" "))
        languages[`.${extension}`] = language;
}
const basenames = {
    dockerfile: "dockerfile",
    containerfile: "dockerfile",
    makefile: "makefile",
    gnumakefile: "makefile",
    "cmakelists.txt": "cmake",
    gemfile: "ruby",
    rakefile: "ruby",
    ".bashrc": "bash",
    ".zshrc": "bash",
    ".bash_profile": "bash",
    ".profile": "bash",
    ".gitignore": "plaintext",
    ".gitattributes": "plaintext",
    ".editorconfig": "ini",
    ".npmrc": "ini",
    ".env": "ini",
    ".htaccess": "apache",
};
const markdownExtensions = new Set([
    ".md",
    ".markdown",
    ".mdown",
    ".mkd",
    ".mdx",
]);
const binaryExtensions = new Set([
    ".zip",
    ".7z",
    ".rar",
    ".tar",
    ".gz",
    ".bz2",
    ".xz",
    ".tgz",
    ".cab",
    ".dmg",
    ".iso",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".a",
    ".o",
    ".class",
    ".pyc",
    ".wasm",
    ".db",
    ".sqlite",
    ".sqlite3",
    ".bin",
    ".dat",
    ".ppt",
    ".xls",
    ".pages",
    ".numbers",
    ".key",
]);
function documentLanguage(name) {
    const base = path.basename(name).toLowerCase();
    return (basenames[base] ||
        (base.startsWith(".env.") ? "ini" : languages[path.extname(base)]));
}
exports.documentLanguage = documentLanguage;
function isDocumentPreviewFile(name) {
    const ext = path.extname(name).toLowerCase();
    return (Boolean(documentLanguage(name)) ||
        exports.conversionExtensions.has(ext) ||
        markdownExtensions.has(ext) ||
        [".txt", ".text", ".log", ".csv", ".tsv", ".rst", ".org"].includes(ext));
}
exports.isDocumentPreviewFile = isDocumentPreviewFile;
/** Reads a prefix, never readFile: also protects against a file growing after stat. */
async function readPreviewBytes(localPath, limit) {
    const handle = await fs.open(localPath, "r");
    try {
        const stat = await handle.stat();
        if (!stat.isFile())
            throw new Error("Not a regular file");
        const buffer = Buffer.alloc(Math.min(stat.size, limit + 1));
        let count = 0;
        while (count < buffer.length) {
            const result = await handle.read(buffer, count, buffer.length - count, count);
            if (!result.bytesRead)
                break;
            count += result.bytesRead;
        }
        return {
            data: buffer.subarray(0, Math.min(count, limit)),
            truncated: stat.size > limit || count > limit,
        };
    }
    finally {
        await handle.close();
    }
}
exports.readPreviewBytes = readPreviewBytes;
async function rawDocumentPreview(localPath, notice = "Unsupported or binary format; showing raw bytes.") {
    try {
        const { data, truncated } = await readPreviewBytes(localPath, exports.MAX_RAW_BYTES);
        const lines = [];
        for (let i = 0; i < data.length; i += 16) {
            const row = data.subarray(i, i + 16);
            const hex = Array.from(row, (b) => b.toString(16).padStart(2, "0"))
                .join(" ")
                .padEnd(47);
            const ascii = Array.from(row, (b) => b >= 32 && b <= 126 ? String.fromCharCode(b) : ".").join("");
            lines.push(`${i.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
        }
        return {
            kind: "binary",
            text: lines.join("\n"),
            encoding: "hex",
            truncated,
            notice,
        };
    }
    catch {
        return {
            kind: "binary",
            text: "",
            truncated: false,
            notice: "File could not be read; no raw preview is available.",
        };
    }
}
exports.rawDocumentPreview = rawDocumentPreview;
function boundedDocumentText(text, notice, alreadyTruncated = false) {
    const bytes = Buffer.from(text, "utf8");
    const truncated = alreadyTruncated || bytes.length > exports.MAX_TEXT_BYTES;
    const clean = new util_1.TextDecoder("utf-8").decode(bytes.subarray(0, exports.MAX_TEXT_BYTES), { stream: bytes.length > exports.MAX_TEXT_BYTES });
    return {
        kind: "document",
        text: clean,
        encoding: "utf-8",
        truncated,
        notice: [
            notice,
            truncated
                ? "Document preview is limited to 256 KiB or the selected pages/entries."
                : undefined,
        ]
            .filter(Boolean)
            .join(" ") || undefined,
    };
}
exports.boundedDocumentText = boundedDocumentText;
function decodeText(data, truncated) {
    let encoding = "utf-8";
    let offset = 0;
    if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf)
        offset = 3;
    else if (data[0] === 0xff && data[1] === 0xfe) {
        encoding = "utf-16le";
        offset = 2;
    }
    else if (data[0] === 0xfe && data[1] === 0xff) {
        encoding = "utf-16be";
        offset = 2;
    }
    else if (data.length >= 8) {
        const sample = data.subarray(0, Math.min(data.length, 4096));
        let evenZero = 0, oddZero = 0;
        for (let i = 0; i < sample.length; i++)
            if (sample[i] === 0)
                i % 2 ? oddZero++ : evenZero++;
        if (oddZero > sample.length * 0.3 && evenZero < sample.length * 0.02)
            encoding = "utf-16le";
        else if (evenZero > sample.length * 0.3 && oddZero < sample.length * 0.02)
            encoding = "utf-16be";
    }
    try {
        const text = new util_1.TextDecoder(encoding, { fatal: true }).decode(data.subarray(offset), { stream: truncated });
        let bad = 0;
        for (const char of text) {
            const code = char.codePointAt(0);
            if (code === 0 || code === 0xfffd)
                return null;
            if ((code < 32 &&
                code !== 9 &&
                code !== 10 &&
                code !== 13 &&
                code !== 12) ||
                (code >= 127 && code <= 159))
                bad++;
        }
        if (bad > 0 && bad / Math.max(text.length, 1) > 0.005)
            return null;
        return { text, encoding };
    }
    catch {
        return null;
    }
}
/** Linear CSV/TSV state machine, including escaped quotes and embedded newlines. */
function parseTable(text, delimiter, truncated) {
    const rows = [];
    let row = [], field = "", quoted = false, closed = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                }
                else {
                    quoted = false;
                    closed = true;
                }
            }
            else
                field += ch;
        }
        else if (ch === '"' && !field && !closed)
            quoted = true;
        else if (ch === delimiter) {
            row.push(field);
            field = "";
            closed = false;
        }
        else if (ch === "\r" || ch === "\n") {
            if (ch === "\r" && text[i + 1] === "\n")
                i++;
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
            closed = false;
        }
        else {
            if (closed)
                throw new Error("Unexpected characters after CSV quote");
            if (ch === '"')
                throw new Error("Unexpected CSV quote");
            field += ch;
        }
    }
    if (quoted && !truncated)
        throw new Error("Unclosed CSV quote");
    const incomplete = truncated && (field.length > 0 || row.length > 0 || quoted || closed);
    if (!incomplete && (field.length > 0 || row.length > 0 || closed)) {
        row.push(field);
        rows.push(row);
    }
    return { rows, incomplete };
}
/** Worker entry implementation. Never logs file content or parser errors. */
async function extractDocumentPreview(localPath, originalName, mimeType) {
    const name = originalName || localPath;
    let ext = path.extname(name).toLowerCase();
    mimeType = mimeType?.split(";", 1)[0].trim().toLowerCase();
    if (!isDocumentPreviewFile(name) &&
        mimeType &&
        conversionMimeExtensions[mimeType])
        ext = conversionMimeExtensions[mimeType];
    if (exports.conversionExtensions.has(ext)) {
        const { convertDocument } = await Promise.resolve().then(() => __importStar(require("./documentPreviewWorker")));
        return convertDocument(localPath, ext);
    }
    if (binaryExtensions.has(ext))
        return rawDocumentPreview(localPath);
    const { data, truncated: inputTruncated } = await readPreviewBytes(localPath, exports.MAX_TEXT_BYTES);
    // Container signatures win over misleading names, including ASCII tar headers.
    if (data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) ||
        data.subarray(0, 5).toString("ascii") === "%PDF-" ||
        data.subarray(257, 262).toString("ascii") === "ustar" ||
        (data[0] === 0x1f && data[1] === 0x8b))
        return rawDocumentPreview(localPath);
    const decoded = decodeText(data, inputTruncated);
    if (!decoded)
        return rawDocumentPreview(localPath, "Content is not sane UTF-8/UTF-16 text; showing raw bytes.");
    const output = Buffer.from(decoded.text, "utf8");
    const truncated = inputTruncated || output.length > exports.MAX_TEXT_BYTES;
    if (output.length > exports.MAX_TEXT_BYTES)
        decoded.text = new util_1.TextDecoder("utf-8").decode(output.subarray(0, exports.MAX_TEXT_BYTES), { stream: true });
    const language = documentLanguage(name);
    let kind = markdownExtensions.has(ext) || mimeType === "text/markdown"
        ? "markdown"
        : language
            ? "code"
            : "text";
    let rows;
    let notice = truncated
        ? "Text preview is limited to 256 KiB; the final character or table row may be omitted."
        : undefined;
    if (ext === ".csv" ||
        ext === ".tsv" ||
        mimeType === "text/csv" ||
        mimeType === "text/tab-separated-values") {
        try {
            rows = parseTable(decoded.text, ext === ".tsv" || mimeType === "text/tab-separated-values" ? "\t" : ",", truncated).rows;
            kind = "table";
        }
        catch {
            kind = "text";
            notice = [notice, "Malformed table; showing the original text instead."]
                .filter(Boolean)
                .join(" ");
        }
    }
    // All strings are inert text: no Markdown or HTML rendering is performed here.
    return {
        kind,
        text: decoded.text,
        encoding: decoded.encoding,
        language,
        truncated,
        notice,
        rows,
    };
}
exports.extractDocumentPreview = extractDocumentPreview;
let activeWorkers = 0;
const pendingWorkers = [];
async function getDocumentPreview(localPath, originalName, mimeType) {
    // Bound both concurrency and queue length, not only each file's memory usage.
    if (activeWorkers >= 2) {
        if (pendingWorkers.length >= 16)
            return rawDocumentPreview(localPath, "Document preview workers are busy; showing raw bytes.");
        await new Promise((resolve) => pendingWorkers.push(resolve));
    }
    else
        activeWorkers++;
    try {
        return await new Promise((resolve) => {
            let worker;
            let settled = false;
            let timer;
            const finish = (preview, notice) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                // Release a slot only once the timed-out parser has actually stopped.
                void worker
                    .terminate()
                    .then(async () => resolve(preview || (await rawDocumentPreview(localPath, notice))));
            };
            try {
                worker = new worker_threads_1.Worker(path.join(__dirname, "documentPreviewWorker.js"), {
                    workerData: { localPath, originalName, mimeType },
                    resourceLimits: {
                        maxOldGenerationSizeMb: 256,
                        maxYoungGenerationSizeMb: 32,
                    },
                });
            }
            catch {
                void rawDocumentPreview(localPath, "Document parser worker is unavailable; showing raw bytes.").then(resolve);
                return;
            }
            timer = setTimeout(() => finish(undefined, "Document conversion exceeded 15 seconds; showing raw bytes."), 15000);
            worker.once("message", (preview) => finish(preview));
            worker.once("error", () => finish(undefined, "Document conversion failed; showing raw bytes."));
            worker.once("exit", () => finish(undefined, "Document parser stopped without a preview; showing raw bytes."));
        });
    }
    finally {
        const next = pendingWorkers.shift();
        if (next)
            next();
        else
            activeWorkers--;
    }
}
exports.getDocumentPreview = getDocumentPreview;
