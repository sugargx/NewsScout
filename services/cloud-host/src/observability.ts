import { SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { AzureMonitorTraceExporter } from "@azure/monitor-opentelemetry-exporter";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { TokenCredential } from "@azure/identity";
import type { IncomingMessage, ServerResponse } from "node:http";

const routes = new Set([
  "/api/v1/session", "/api/v1/runtime", "/api/v1/me/interests", "/api/v1/me/telemetry-consent", "/api/v1/me/export",
  "/api/v1/events", "/api/v1/events/:id", "/api/v1/events/:id/state", "/api/v1/events/exposures",
  "/api/v1/explore", "/api/v1/briefs", "/api/v1/briefs/:date", "/api/v1/briefs/:date/generate", "/api/v1/weekly",
  "/api/v1/sources", "/api/v1/sources/coverage", "/api/v1/sources/:id", "/api/v1/sources/:id/refresh",
  "/api/v1/sources/:id/x-posts", "/api/v1/source-watchlist", "/api/v1/admin/ingestion/run", "/api/v1/ingestion-runs/:id",
  "/api/v1/shares", "/api/v1/shares/:id", "/api/v1/shares/:id/draft", "/api/v1/shares/:id/publish",
  "/api/v1/share-settings", "/api/v1/reader-status", "/api/v1/reader-settings", "/api/v1/telemetry",
]);
export function routeName(path: string): string {
  const normalized = path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/briefs\/(?:\d{4}-\d{2}-\d{2}|today|latest)(?=\/|$)/, "/briefs/:date");
  return routes.has(normalized) ? normalized : "unmatched";
}

export function createMonitor(connectionString: string, credential: TokenCredential) {
  const exporter = new AzureMonitorTraceExporter({ connectionString, credential });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "newsscout-web", "deployment.environment.name": "invited-preview" }),
    spanProcessors: [new BatchSpanProcessor(exporter, { maxQueueSize: 512, maxExportBatchSize: 64, exportTimeoutMillis: 15_000 })],
  });
  return { tracer: provider.getTracer("newsscout"), shutdown: () => provider.shutdown() };
}

export function observeRequest(tracer: Tracer, request: IncomingMessage, response: ServerResponse, path: string) {
  const method = ["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"].includes(request.method ?? "") ? request.method! : "OTHER";
  const route = routeName(path);
  const span = tracer.startSpan(`${method} ${route}`, {
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": method, "http.route": route },
  });
  const started = performance.now();
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    span.setAttribute("http.response.status_code", response.statusCode);
    if (response.statusCode >= 500 || !response.writableFinished) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    console.info(JSON.stringify({
      category: "http_request", method, route, status: response.statusCode,
      durationMs: Math.round(performance.now() - started), traceId: span.spanContext().traceId,
    }));
  };
  response.once("finish", end);
  response.once("close", end);
  return `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`;
}
