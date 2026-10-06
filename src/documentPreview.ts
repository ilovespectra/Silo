import * as fs from "fs/promises";
import * as path from "path";
import { Worker } from "worker_threads";
import { TextDecoder } from "util";

export interface DocumentPreview {
  kind: "code" | "text" | "markdown" | "table" | "document" | "binary";
  text: string;
  language?: string;
  encoding?: string;
  truncated: boolean;
  notice?: string;
  rows?: string[][];
}

export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_RAW_BYTES = 8 * 1024;
export const MAX_XML_ENTRY_BYTES = 2 * 1024 * 1024;
export const MAX_XML_TOTAL_BYTES = 8 * 1024 * 1024;
export const conversionExtensions = new Set([
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
const conversionMimeExtensions: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/rtf": ".rtf",
  "text/rtf": ".rtf",
  "application/epub+zip": ".epub",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.oasis.opendocument.text": ".odt",
  "application/vnd.oasis.opendocument.spreadsheet": ".ods",
  "application/vnd.oasis.opendocument.presentation": ".odp",
};

const languages: Record<string, string> = {};
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
const basenames: Record<string, string> = {
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

export function documentLanguage(name: string): string | undefined {
  const base = path.basename(name).toLowerCase();
  return (
    basenames[base] ||
    (base.startsWith(".env.") ? "ini" : languages[path.extname(base)])
  );
}

export function isDocumentPreviewFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return (
    Boolean(documentLanguage(name)) ||
    conversionExtensions.has(ext) ||
    markdownExtensions.has(ext) ||
    [".txt", ".text", ".log", ".csv", ".tsv", ".rst", ".org"].includes(ext)
  );
}

/** Reads a prefix, never readFile: also protects against a file growing after stat. */
export async function readPreviewBytes(
  localPath: string,
  limit: number,
): Promise<{ data: Buffer; truncated: boolean }> {
  const handle = await fs.open(localPath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Not a regular file");
    const buffer = Buffer.alloc(Math.min(stat.size, limit + 1));
    let count = 0;
    while (count < buffer.length) {
      const result = await handle.read(
        buffer,
        count,
        buffer.length - count,
        count,
      );
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    return {
      data: buffer.subarray(0, Math.min(count, limit)),
      truncated: stat.size > limit || count > limit,
    };
  } finally {
    await handle.close();
  }
}

export async function rawDocumentPreview(
  localPath: string,
  notice = "Unsupported or binary format; showing raw bytes.",
): Promise<DocumentPreview> {
  try {
    const { data, truncated } = await readPreviewBytes(
      localPath,
      MAX_RAW_BYTES,
    );
    const lines: string[] = [];
    for (let i = 0; i < data.length; i += 16) {
      const row = data.subarray(i, i + 16);
      const hex = Array.from(row, (b) => b.toString(16).padStart(2, "0"))
        .join(" ")
        .padEnd(47);
      const ascii = Array.from(row, (b) =>
        b >= 32 && b <= 126 ? String.fromCharCode(b) : ".",
      ).join("");
      lines.push(`${i.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
    }
    return {
      kind: "binary",
      text: lines.join("\n"),
      encoding: "hex",
      truncated,
      notice,
    };
  } catch {
    return {
      kind: "binary",
      text: "",
      truncated: false,
      notice: "File could not be read; no raw preview is available.",
    };
  }
}

export function boundedDocumentText(
  text: string,
  notice?: string,
  alreadyTruncated = false,
): DocumentPreview {
  const bytes = Buffer.from(text, "utf8");
  const truncated = alreadyTruncated || bytes.length > MAX_TEXT_BYTES;
  const clean = new TextDecoder("utf-8").decode(
    bytes.subarray(0, MAX_TEXT_BYTES),
    { stream: bytes.length > MAX_TEXT_BYTES },
  );
  return {
    kind: "document",
    text: clean,
    encoding: "utf-8",
    truncated,
    notice:
      [
        notice,
        truncated
          ? "Document preview is limited to 256 KiB or the selected pages/entries."
          : undefined,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}

function decodeText(
  data: Buffer,
  truncated: boolean,
): { text: string; encoding: string } | null {
  let encoding = "utf-8";
  let offset = 0;
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) offset = 3;
  else if (data[0] === 0xff && data[1] === 0xfe) {
    encoding = "utf-16le";
    offset = 2;
  } else if (data[0] === 0xfe && data[1] === 0xff) {
    encoding = "utf-16be";
    offset = 2;
  } else if (data.length >= 8) {
    const sample = data.subarray(0, Math.min(data.length, 4096));
    let evenZero = 0,
      oddZero = 0;
    for (let i = 0; i < sample.length; i++)
      if (sample[i] === 0) i % 2 ? oddZero++ : evenZero++;
    if (oddZero > sample.length * 0.3 && evenZero < sample.length * 0.02)
      encoding = "utf-16le";
    else if (evenZero > sample.length * 0.3 && oddZero < sample.length * 0.02)
      encoding = "utf-16be";
  }
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(
      data.subarray(offset),
      { stream: truncated },
    );
    let bad = 0;
    for (const char of text) {
      const code = char.codePointAt(0)!;
      if (code === 0 || code === 0xfffd) return null;
      if (
        (code < 32 &&
          code !== 9 &&
          code !== 10 &&
          code !== 13 &&
          code !== 12) ||
        (code >= 127 && code <= 159)
      )
        bad++;
    }
    if (bad > 0 && bad / Math.max(text.length, 1) > 0.005) return null;
    return { text, encoding };
  } catch {
    return null;
  }
}

/** Linear CSV/TSV state machine, including escaped quotes and embedded newlines. */
function parseTable(
  text: string,
  delimiter: string,
  truncated: boolean,
): { rows: string[][]; incomplete: boolean } {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += ch;
    } else if (ch === '"' && !field && !closed) quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
      closed = false;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closed = false;
    } else {
      if (closed) throw new Error("Unexpected characters after CSV quote");
      if (ch === '"') throw new Error("Unexpected CSV quote");
      field += ch;
    }
  }
  if (quoted && !truncated) throw new Error("Unclosed CSV quote");
  const incomplete =
    truncated && (field.length > 0 || row.length > 0 || quoted || closed);
  if (!incomplete && (field.length > 0 || row.length > 0 || closed)) {
    row.push(field);
    rows.push(row);
  }
  return { rows, incomplete };
}

/** Worker entry implementation. Never logs file content or parser errors. */
export async function extractDocumentPreview(
  localPath: string,
  originalName?: string,
  mimeType?: string | null,
): Promise<DocumentPreview> {
  const name = originalName || localPath;
  let ext = path.extname(name).toLowerCase();
  mimeType = mimeType?.split(";", 1)[0].trim().toLowerCase();
  if (
    !isDocumentPreviewFile(name) &&
    mimeType &&
    conversionMimeExtensions[mimeType]
  )
    ext = conversionMimeExtensions[mimeType];
  if (conversionExtensions.has(ext)) {
    const { convertDocument } = await import("./documentPreviewWorker");
    return convertDocument(localPath, ext);
  }
  if (binaryExtensions.has(ext)) return rawDocumentPreview(localPath);
  const { data, truncated: inputTruncated } = await readPreviewBytes(
    localPath,
    MAX_TEXT_BYTES,
  );
  // Container signatures win over misleading names, including ASCII tar headers.
  if (
    data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) ||
    data.subarray(0, 5).toString("ascii") === "%PDF-" ||
    data.subarray(257, 262).toString("ascii") === "ustar" ||
    (data[0] === 0x1f && data[1] === 0x8b)
  )
    return rawDocumentPreview(localPath);
  const decoded = decodeText(data, inputTruncated);
  if (!decoded)
    return rawDocumentPreview(
      localPath,
      "Content is not sane UTF-8/UTF-16 text; showing raw bytes.",
    );
  const output = Buffer.from(decoded.text, "utf8");
  const truncated = inputTruncated || output.length > MAX_TEXT_BYTES;
  if (output.length > MAX_TEXT_BYTES)
    decoded.text = new TextDecoder("utf-8").decode(
      output.subarray(0, MAX_TEXT_BYTES),
      { stream: true },
    );
  const language = documentLanguage(name);
  let kind: DocumentPreview["kind"] =
    markdownExtensions.has(ext) || mimeType === "text/markdown"
      ? "markdown"
      : language
        ? "code"
        : "text";
  let rows: string[][] | undefined;
  let notice = truncated
    ? "Text preview is limited to 256 KiB; the final character or table row may be omitted."
    : undefined;
  if (
    ext === ".csv" ||
    ext === ".tsv" ||
    mimeType === "text/csv" ||
    mimeType === "text/tab-separated-values"
  ) {
    try {
      rows = parseTable(
        decoded.text,
        ext === ".tsv" || mimeType === "text/tab-separated-values" ? "\t" : ",",
        truncated,
      ).rows;
      kind = "table";
    } catch {
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

let activeWorkers = 0;
const pendingWorkers: Array<() => void> = [];

export async function getDocumentPreview(
  localPath: string,
  originalName?: string,
  mimeType?: string | null,
): Promise<DocumentPreview> {
  // Bound both concurrency and queue length, not only each file's memory usage.
  if (activeWorkers >= 2) {
    if (pendingWorkers.length >= 16)
      return rawDocumentPreview(
        localPath,
        "Document preview workers are busy; showing raw bytes.",
      );
    await new Promise<void>((resolve) => pendingWorkers.push(resolve));
  } else activeWorkers++;
  try {
    return await new Promise<DocumentPreview>((resolve) => {
      let worker: Worker;
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (preview?: DocumentPreview, notice?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Release a slot only once the timed-out parser has actually stopped.
        void worker
          .terminate()
          .then(async () =>
            resolve(preview || (await rawDocumentPreview(localPath, notice))),
          );
      };
      try {
        worker = new Worker(path.join(__dirname, "documentPreviewWorker.js"), {
          workerData: { localPath, originalName, mimeType },
          resourceLimits: {
            maxOldGenerationSizeMb: 256,
            maxYoungGenerationSizeMb: 32,
          },
        });
      } catch {
        void rawDocumentPreview(
          localPath,
          "Document parser worker is unavailable; showing raw bytes.",
        ).then(resolve);
        return;
      }
      timer = setTimeout(
        () =>
          finish(
            undefined,
            "Document conversion exceeded 15 seconds; showing raw bytes.",
          ),
        15000,
      );
      worker.once("message", (preview: DocumentPreview) => finish(preview));
      worker.once("error", () =>
        finish(undefined, "Document conversion failed; showing raw bytes."),
      );
      worker.once("exit", () =>
        finish(
          undefined,
          "Document parser stopped without a preview; showing raw bytes.",
        ),
      );
    });
  } finally {
    const next = pendingWorkers.shift();
    if (next) next();
    else activeWorkers--;
  }
}
