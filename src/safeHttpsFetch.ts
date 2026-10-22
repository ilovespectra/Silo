import * as https from "https";
import { IncomingMessage } from "http";
import { Readable } from "stream";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

type RequestBody = Buffer | undefined;

/**
 * Main-process HTTPS requests must not use Node fetch's transparent Brotli
 * decoder until the Electron runtime includes the upstream Node security fix.
 * This transport asks for identity encoding and exposes the raw response stream;
 * if a server ignores that request and sends any encoded body, it is rejected
 * before application code can consume it.
 */
export async function safeHttpsFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  let url = new URL(input instanceof URL ? input.href : input);
  if (url.protocol !== "https:") {
    throw new TypeError("Only HTTPS requests are allowed.");
  }

  const headers = new Headers(init.headers);
  headers.set("accept-encoding", "identity");
  const method = (init.method || "GET").toUpperCase();
  let requestMethod = method;
  let body = await serializeBody(init.body, headers);
  if ((requestMethod === "GET" || requestMethod === "HEAD") && body) {
    throw new TypeError(`${requestMethod} requests cannot have a body.`);
  }
  if (body && !headers.has("content-length")) {
    headers.set("content-length", String(body.length));
  }

  const redirectMode = init.redirect ?? "follow";
  let redirected = false;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (init.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    const response = await requestOnce(
      url,
      requestMethod,
      headers,
      body,
      init.signal ?? undefined,
    );
    const location = response.headers.location;

    if (location && REDIRECT_STATUSES.has(response.statusCode ?? 0)) {
      if (redirectMode === "error") {
        response.resume();
        throw new TypeError("Request was redirected, but redirect mode is error.");
      }
      if (redirectMode === "follow") {
        if (redirectCount === MAX_REDIRECTS) {
          response.resume();
          throw new TypeError("Too many HTTPS redirects.");
        }
        const nextUrl = new URL(location, url);
        if (nextUrl.protocol !== "https:") {
          response.resume();
          throw new TypeError("Refusing an HTTPS redirect to a non-HTTPS URL.");
        }

        if (nextUrl.origin !== url.origin) {
          headers.delete("authorization");
          headers.delete("cookie");
          headers.delete("proxy-authorization");
        }
        if (
          response.statusCode === 303 ||
          ((response.statusCode === 301 || response.statusCode === 302) &&
            requestMethod !== "GET" &&
            requestMethod !== "HEAD")
        ) {
          requestMethod = "GET";
          body = undefined;
          headers.delete("content-length");
          headers.delete("content-type");
          headers.delete("transfer-encoding");
        }

        response.resume();
        url = nextUrl;
        redirected = true;
        continue;
      }
    }

    const contentEncoding = response.headers["content-encoding"];
    if (
      contentEncoding &&
      contentEncoding
        .toString()
        .split(",")
        .some((encoding) => encoding.trim().toLowerCase() !== "identity")
    ) {
      response.resume();
      throw new Error(
        `Blocked an encoded HTTPS response from ${url.hostname}; compressed responses are disabled for this request.`,
      );
    }

    const status = response.statusCode ?? 502;
    const hasNoBody =
      requestMethod === "HEAD" || status === 204 || status === 205 || status === 304;
    let responseBody: ReadableStream<Uint8Array> | null = null;
    if (hasNoBody) {
      response.resume();
    } else {
      responseBody = Readable.toWeb(response) as ReadableStream<Uint8Array>;
    }

    const result = new Response(responseBody, {
      status,
      statusText: response.statusMessage,
      headers: response.headers as Record<string, string>,
    });
    Object.defineProperties(result, {
      url: { value: url.href },
      redirected: { value: redirected },
    });
    return result;
  }

  throw new TypeError("Too many HTTPS redirects.");
}

async function serializeBody(
  body: BodyInit | null | undefined,
  headers: Headers,
): Promise<RequestBody> {
  if (body == null) return undefined;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    }
    return Buffer.from(body.toString());
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  throw new TypeError("This HTTPS helper only supports replayable request bodies.");
}

function requestOnce(
  url: URL,
  method: string,
  headers: Headers,
  body: RequestBody,
  signal: AbortSignal | undefined,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      requestHeaders[name] = value;
    });

    const request = https.request(
      url,
      {
        method,
        headers: requestHeaders,
        signal,
      },
      resolve,
    );
    request.once("error", reject);
    request.end(body);
  });
}
