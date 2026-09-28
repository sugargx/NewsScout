import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep, extname, join } from "node:path";
import { Readable, type Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { brotliCompress, constants as zlib, createBrotliCompress, createGzip, gzip } from "node:zlib";
import type { Tracer } from "@opentelemetry/api";
import { observeRequest, routeName } from "./observability.js";
import type { ExportArchive } from "./storage.js";

export interface CloudHostOptions {
  site: string;
  apiUrl: string;
  proxyToken: string;
  tracer: Tracer;
  exports: ExportArchive;
}
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

const compressibleAssets = new Set([".html", ".js", ".css", ".svg"]);
const minimumCompressedBytes = 1024;
const brotli = promisify(brotliCompress), gzipBuffer = promisify(gzip);
type Encoding = "br" | "gzip";
interface StaticVariant { identity: Buffer; br?: Buffer; gzip?: Buffer }

export function preferredEncoding(header: string | string[] | undefined): Encoding | undefined {
  const quality = new Map<string, number>();
  for (const part of (Array.isArray(header) ? header.join(",") : header ?? "").split(",")) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = parameters.map(value => value.trim()).find(value => value.startsWith("q="));
    const value = q ? Number(q.slice(2)) : 1;
    quality.set(name, Number.isFinite(value) ? value : 0);
  }
  const accepts = (name: Encoding) => (quality.get(name) ?? quality.get("*") ?? 0) > 0;
  return accepts("br") ? "br" : accepts("gzip") ? "gzip" : undefined;
}
async function staticVariant(data: Buffer, compressible: boolean): Promise<StaticVariant> {
  if (!compressible || data.length < minimumCompressedBytes) return { identity: data };
  const [br, gz] = await Promise.all([
    brotli(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: data.length } }),
    gzipBuffer(data, { level: 9 }),
  ]);
  return { identity: data, ...(br.length < data.length ? { br } : {}), ...(gz.length < data.length ? { gzip: gz } : {}) };
}
function sendStatic(request: IncomingMessage, response: ServerResponse, variant: StaticVariant) {
  if (variant.br || variant.gzip) response.setHeader("Vary", "Accept-Encoding");
  const encoding = preferredEncoding(request.headers["accept-encoding"]);
  const body = encoding ? variant[encoding] : undefined;
  if (encoding && body) response.setHeader("Content-Encoding", encoding);
  const payload = body ?? variant.identity;
  response.setHeader("Content-Length", payload.length);
  response.end(request.method === "HEAD" ? undefined : payload);
}
function responseCompressor(request: IncomingMessage, upstream: Response): { encoding: Encoding; stream: Transform } | undefined {
  if (request.method === "HEAD" || !upstream.body || upstream.headers.has("content-encoding")) return undefined;
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(upstream.headers.get("content-type") ?? "")) return undefined;
  const length = Number(upstream.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(length) && length < minimumCompressedBytes) return undefined;
  const encoding = preferredEncoding(request.headers["accept-encoding"]);
  if (encoding === "br") return { encoding, stream: createBrotliCompress({ params: { [zlib.BROTLI_PARAM_QUALITY]: 4 } }) };
  if (encoding === "gzip") return { encoding, stream: createGzip({ level: 6 }) };
  return undefined;
}

class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "internal_error";
}
function secureHeaders(response: ServerResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.removeHeader("Content-Encoding");
  response.removeHeader("Content-Length");
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_048_576) throw new RequestError(413, "请求内容过大。");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
function upstreamHeaders(request: IncomingMessage, proxyToken: string, traceparent: string) {
  const result = new Headers({ "X-ScoutNews-Proxy-Token": proxyToken, traceparent });
  for (const name of ["content-type", "accept", "origin", "x-csrf-token", "x-ms-client-principal", "sec-fetch-site"]) {
    const value = request.headers[name];
    if (typeof value === "string") result.set(name, value);
  }
  return result;
}

export async function createCloudServer(options: CloudHostOptions) {
  const site = await realpath(options.site);
  const api = new URL(options.apiUrl);
  if (api.protocol !== "http:" || api.hostname !== "127.0.0.1" || api.pathname !== "/" || api.search || api.username || api.password) {
    throw new Error("Cloud API must use a loopback-only HTTP origin.");
  }
  if (options.proxyToken.length < 32) throw new Error("A strong private proxy token is required.");
  const source = await readFile(resolve(site, "index.html"), "utf8");
  if (!/<html\b/i.test(source)) throw new Error("Missing application HTML root.");
  const index = source.replace(/<html\b([^>]*)>/i, (_, attributes: string) =>
    `<html${attributes.replace(/\sdata-(?:deployment|public-reader)\s*=\s*["'][^"']*["']/gi, "")} data-deployment="azure">`);
  const indexVariant = await staticVariant(Buffer.from(index, "utf8"), true);
  const assets = new Map<string, Promise<StaticVariant>>();
  const asset = (file: string, size: number, modified: number) => {
    const key = `${file}\0${size}\0${modified}`;
    let variant = assets.get(key);
    if (!variant) {
      variant = readFile(file).then(data => staticVariant(data, compressibleAssets.has(extname(file))));
      variant.catch(() => assets.delete(key));
      assets.set(key, variant);
    }
    return variant;
  };
  // Immutable bundles are compressed once at startup so the first reader does not wait for maximum-quality Brotli.
  void readdir(join(site, "assets"), { withFileTypes: true })
    .then(entries => Promise.all(entries.filter(entry => entry.isFile() && compressibleAssets.has(extname(entry.name))).map(async entry => {
      const file = await realpath(join(site, "assets", entry.name));
      if (!file.startsWith(site + sep)) return;
      const info = await stat(file);
      await asset(file, info.size, info.mtimeMs);
    })))
    .catch(() => undefined);

  async function handle(request: IncomingMessage, response: ServerResponse) {
    secureHeaders(response);
    if (!request.url?.startsWith("/") || request.url.startsWith("//")) throw new RequestError(400, "请求地址无效。");
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/health") {
      if (!["GET", "HEAD"].includes(request.method ?? "")) throw new RequestError(405, "不支持该方法。");
      const health = await fetch(new URL("/health", api), { signal: AbortSignal.timeout(5000), redirect: "error" });
      json(response, health.ok ? 200 : 503, { status: health.ok ? "ready" : "unavailable", deployment: "customer-preview" });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const traceparent = observeRequest(options.tracer, request, response, url.pathname);
      const readOnly = ["GET", "HEAD"].includes(request.method ?? "");
      const disconnected = new AbortController();
      const cancelRead = () => { if (!response.writableFinished) disconnected.abort(); };
      if (readOnly) response.once("close", cancelRead);
      try {
        const bytes = readOnly ? undefined : await body(request);
        const timeout = AbortSignal.timeout(230_000);
        const upstream = await fetch(new URL(url.pathname + url.search, api), {
          method: request.method,
          headers: upstreamHeaders(request, options.proxyToken, traceparent),
          body: bytes?.length ? bytes : undefined,
          redirect: "error",
          signal: readOnly ? AbortSignal.any([timeout, disconnected.signal]) : timeout,
        });
        if (url.pathname === "/api/v1/me/export" && request.method === "POST" && upstream.ok) {
          const data = Buffer.from(await upstream.arrayBuffer());
          if (data.length > 20 * 1024 * 1024) throw new RequestError(502, "导出文件超过当前限制，请联系维护者。");
          const document: unknown = JSON.parse(data.toString("utf8"));
          if (typeof document !== "object" || document === null || !("userId" in document) || typeof document.userId !== "string") {
            throw new RequestError(502, "导出响应不完整。");
          }
          await options.exports.save(document.userId, data);
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": 'attachment; filename="newsscout-data.json"',
          });
          response.end(data);
          return;
        }
        response.statusCode = upstream.status;
        response.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json; charset=utf-8");
        response.setHeader("Vary", "Cookie, Accept-Encoding");
        const compressor = responseCompressor(request, upstream);
        if (compressor) response.setHeader("Content-Encoding", compressor.encoding);
        if (upstream.body && request.method !== "HEAD") {
          if (compressor) await pipeline(Readable.fromWeb(upstream.body), compressor.stream, response);
          else await pipeline(Readable.fromWeb(upstream.body), response);
        }
        else response.end();
      } catch (error) {
        if (disconnected.signal.aborted && error === disconnected.signal.reason && response.destroyed) return;
        throw error;
      } finally {
        if (readOnly) response.removeListener("close", cancelRead);
      }
      return;
    }
    if (!["GET", "HEAD"].includes(request.method ?? "")) throw new RequestError(405, "不支持该方法。");
    let decoded: string;
    try { decoded = decodeURIComponent(url.pathname); }
    catch (error) { if (error instanceof URIError) throw new RequestError(400, "请求地址编码无效。"); throw error; }
    if (decoded.includes("\\") || decoded.includes("\0")) throw new RequestError(400, "请求地址无效。");
    const file = resolve(site, `.${decoded}`);
    if (file !== site && !file.startsWith(site + sep)) throw new RequestError(404, "资源不存在。");
    let info: Awaited<ReturnType<typeof stat>> | undefined;
    try { info = await stat(file); }
    catch (error) { if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw error; }
    if (info?.isFile() && extname(file) !== ".html") {
      const actual = await realpath(file);
      if (!actual.startsWith(site + sep)) throw new RequestError(404, "资源不存在。");
      const contentType = mime[extname(file)];
      if (!contentType) throw new RequestError(404, "资源不存在。");
      response.setHeader("Content-Type", contentType);
      if (url.pathname.startsWith("/assets/")) response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      sendStatic(request, response, await asset(actual, Number(info.size), Number(info.mtimeMs)));
      return;
    }
    if (url.pathname.startsWith("/assets/") || extname(url.pathname)) throw new RequestError(404, "资源不存在。");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    sendStatic(request, response, indexVariant);
  }
  return createServer({ maxHeaderSize: 32 * 1024, requestTimeout: 240_000 }, (request, response) => {
    void handle(request, response).catch(error => {
      const status = error instanceof RequestError ? error.status : error instanceof Error && error.name === "TimeoutError" ? 504 : 502;
      console.error(JSON.stringify({ category: "host_error", status, code: errorCode(error), route: routeName((request.url ?? "").split("?")[0]) }));
      if (response.headersSent) { response.destroy(); return; }
      json(response, status, { error: error instanceof RequestError ? error.message : "服务暂时不可用，请稍后重试。" });
    });
  });
}
