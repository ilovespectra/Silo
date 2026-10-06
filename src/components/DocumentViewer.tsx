import React, { useMemo, useState } from "react";
import hljs from "highlight.js";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DocumentPreview } from "../documentPreview";
import "highlight.js/styles/github-dark.css";
import "../styles/DocumentViewer.css";

function CodeText({ text, language }: { text: string; language?: string }) {
  const highlighted = useMemo(() => {
    if (text.length > 100000 || !language || !hljs.getLanguage(language))
      return null;
    try {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [text, language]);
  return (
    <pre className="document-code">
      <code
        className="hljs"
        {...(highlighted !== null
          ? { dangerouslySetInnerHTML: { __html: highlighted } }
          : { children: text })}
      />
    </pre>
  );
}

export default function DocumentViewer({
  document,
  name,
  compact = false,
}: {
  document: DocumentPreview;
  name: string;
  compact?: boolean;
}) {
  const [raw, setRaw] = useState(false);
  const text = compact ? document.text.slice(0, 4000) : document.text;
  const paragraphs = useMemo(() => text.split(/\n\s*\n/), [text]);
  return (
    <section
      className={`document-viewer ${compact ? "compact" : ""}`}
      aria-label={`Document preview: ${name}`}
    >
      <header className="document-viewer-toolbar">
        <span>
          {document.kind === "binary"
            ? "RAW BYTES · HEX / ASCII"
            : document.language?.toUpperCase() || document.kind.toUpperCase()}
          {document.encoding ? ` · ${document.encoding}` : ""}
        </span>
        {!compact &&
          ["markdown", "table", "document"].includes(document.kind) && (
            <button onClick={() => setRaw((value) => !value)}>
              {raw ? "Formatted" : "Plain text"}
            </button>
          )}
      </header>
      {(document.notice || document.truncated) && (
        <p className="document-preview-notice" role="status">
          {document.notice}{" "}
          {document.truncated
            ? "Preview limited for performance; the original file is unchanged."
            : ""}
        </p>
      )}
      <div className="document-viewer-content">
        {raw || document.kind === "code" || document.kind === "binary" ? (
          <CodeText
            text={text}
            language={document.kind === "code" ? document.language : undefined}
          />
        ) : document.kind === "markdown" ? (
          <article className="document-paper">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{
                a: ({ children }) => (
                  <span className="document-link">{children}</span>
                ),
                img: ({ alt }) => (
                  <span className="document-link">
                    [Image: {alt || "embedded image"}]
                  </span>
                ),
                code: ({ inline, className, children }) =>
                  inline ? (
                    <code>{children}</code>
                  ) : (
                    <CodeText
                      text={String(children).replace(/\n$/, "")}
                      language={/language-([\w-]+)/.exec(className || "")?.[1]}
                    />
                  ),
              }}
            >
              {text}
            </ReactMarkdown>
          </article>
        ) : document.kind === "table" && document.rows ? (
          <div className="document-table-wrap">
            <table>
              <tbody>
                {document.rows
                  .slice(0, compact ? 8 : 1000)
                  .map((row, index) => (
                    <tr key={index}>
                      {row
                        .slice(0, 100)
                        .map((cell, column) =>
                          index === 0 ? (
                            <th key={column}>{cell}</th>
                          ) : (
                            <td key={column}>{cell}</td>
                          ),
                        )}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <article className="document-paper">
            {paragraphs.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
            {!text && (
              <p className="document-empty">
                This document contains no extractable text.
              </p>
            )}
          </article>
        )}
      </div>
    </section>
  );
}
