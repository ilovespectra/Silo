/// <reference types="node" />
/// <reference types="node" />
export interface DocumentPreview {
    kind: "code" | "text" | "markdown" | "table" | "document" | "binary";
    text: string;
    language?: string;
    encoding?: string;
    truncated: boolean;
    notice?: string;
    rows?: string[][];
}
export declare const MAX_TEXT_BYTES: number;
export declare const MAX_RAW_BYTES: number;
export declare const MAX_XML_ENTRY_BYTES: number;
export declare const MAX_XML_TOTAL_BYTES: number;
export declare const conversionExtensions: Set<string>;
export declare function documentLanguage(name: string): string | undefined;
export declare function isDocumentPreviewFile(name: string): boolean;
/** Reads a prefix, never readFile: also protects against a file growing after stat. */
export declare function readPreviewBytes(localPath: string, limit: number): Promise<{
    data: Buffer;
    truncated: boolean;
}>;
export declare function rawDocumentPreview(localPath: string, notice?: string): Promise<DocumentPreview>;
export declare function boundedDocumentText(text: string, notice?: string, alreadyTruncated?: boolean): DocumentPreview;
/** Worker entry implementation. Never logs file content or parser errors. */
export declare function extractDocumentPreview(localPath: string, originalName?: string, mimeType?: string | null): Promise<DocumentPreview>;
export declare function getDocumentPreview(localPath: string, originalName?: string, mimeType?: string | null): Promise<DocumentPreview>;
