import type { Brief, BriefHistory, Event, EventState, Exploration, IngestionResult, NewSource, Processing, ProcessingSettings, Provider, ReaderSettings, ReaderStatus, Runtime, Source, SourceCoverage, Topic, SourceWatch, ShareDocument, ShareLink, ReaderSession } from "./types";

let csrfToken: string | null = null;
let sessionUserId: string | null = null;
let documentReaderId: string | null = null;
let sessionEpoch = 0;
let sessionValidation: Promise<void> | null = null;
let finishValidation: (() => void) | null = null;
const cloudSession = () => typeof document !== "undefined" && document.documentElement.dataset.deployment === "azure";
export const getDocumentReaderId = () => documentReaderId;
export class SessionChangedError extends Error {}
export function suspendSessionRequests() {
  document.documentElement.dataset.sessionValidation = "pending";
  if (!sessionValidation) sessionValidation = new Promise(resolve => { finishValidation = resolve; });
}
export function setSessionCsrfToken(value: string | null, userId: string | null = null) {
  if (value && userId && cloudSession() && documentReaderId && documentReaderId !== userId) {
    setSessionCsrfToken(null);
    throw new SessionChangedError("账号已切换，需要重新载入阅读空间。");
  }
  if (sessionUserId !== userId || value === null) sessionEpoch++;
  sessionUserId = userId;
  csrfToken = value;
  if (value && userId && cloudSession()) {
    documentReaderId = userId;
    delete document.documentElement.dataset.sessionValidation;
  }
  const finish = finishValidation;
  sessionValidation = null;
  finishValidation = null;
  finish?.();
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public invitationKey?: string) { super(message); }
}

export const isInvitationRequired = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === 403 && error.code === "invitation_required";

async function confirmRequestSession(epoch: number, signal?: AbortSignal | null) {
  while (sessionValidation) await sessionValidation;
  signal?.throwIfAborted();
  if (!csrfToken || !sessionUserId || epoch !== sessionEpoch) throw new DOMException("账号会话尚未确认或已切换。", "AbortError");
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const requestEpoch = sessionEpoch;
  const protectedRequest = cloudSession() && path !== "/api/v1/session" && !path.startsWith("/api/v1/public/");
  if (protectedRequest) await confirmRequestSession(requestEpoch, init?.signal);
  let response: Response;
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (csrfToken && init?.method && !["GET", "HEAD"].includes(init.method)) headers.set("X-CSRF-Token", csrfToken);
  try {
    response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin", headers });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("无法连接 NewsScout 服务。请检查网络后重试。");
  }
  if (protectedRequest) await confirmRequestSession(requestEpoch, init?.signal);
  if (path !== "/api/v1/session" && requestEpoch !== sessionEpoch) throw new DOMException("账号会话已切换。", "AbortError");
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown; invitationKey?: unknown } | null;
    const code = typeof body?.error === "string" ? body.error : undefined;
    const message = typeof body?.message === "string" ? body.message : code ?? "请求失败";
    const invitationKey = typeof body?.invitationKey === "string" ? body.invitationKey : undefined;
    const error = new ApiError(`${message}（HTTP ${response.status}）`, response.status, code, invitationKey);
    if (protectedRequest && (response.status === 401 || isInvitationRequired(error))) {
      window.dispatchEvent(new globalThis.Event("newsscout-session-expired"));
    }
    throw error;
  }
  const result = await response.json() as T;
  if (protectedRequest) await confirmRequestSession(requestEpoch, init?.signal);
  if (path !== "/api/v1/session" && requestEpoch !== sessionEpoch) throw new DOMException("账号会话已切换。", "AbortError");
  return result;
}

interface IngestionRun {
  jobId: string;
  status: "pending" | "running" | "succeeded" | "failed";
  result?: IngestionResult | null;
  error?: string | null;
}
async function collect(path: string): Promise<IngestionResult> {
  const epoch = sessionEpoch;
  const started = await request<IngestionResult | IngestionRun>(path, { method: "POST" });
  if (!("jobId" in started)) return started;
  let run = started;
  const deadline = Date.now() + 30 * 60 * 1000;
  while (run.status === "pending" || run.status === "running") {
    if (epoch !== sessionEpoch) throw new DOMException("账号会话已切换。", "AbortError");
    if (Date.now() >= deadline) throw new Error("采集仍在后台进行，尚未报告完成。请稍后回到来源页查看更新；重新发起会恢复现有任务。");
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (epoch !== sessionEpoch) throw new DOMException("账号会话已切换。", "AbortError");
    run = await request<IngestionRun>("/api/v1/ingestion-runs/" + encodeURIComponent(run.jobId));
  }
  if (run.status !== "succeeded" || !run.result) throw new Error(run.error === "worker_interrupted" ? "采集因服务重启而中断，请重新发起。" : "采集任务未完成，请稍后重试。");
  return run.result;
}

export const api = {
  session: (signal?: AbortSignal) => request<ReaderSession>("/api/v1/session", { signal }),
  telemetryConsent: (enabled: boolean) => request<{ enabled: boolean }>("/api/v1/me/telemetry-consent", { method: "PUT", body: JSON.stringify({ enabled }) }),
  exportData: () => request<Record<string, unknown>>("/api/v1/me/export", { method: "POST", body: "{}" }),
  telemetry: (events: { name: string; page: string; outcome?: "success" | "failure"; durationMs?: number }[]) =>
    request<{ accepted: number }>("/api/v1/telemetry", { method: "POST", body: JSON.stringify({ events }) }),
  events: (params = "", signal?: AbortSignal) => request<{ items: Event[]; nextOffset: number | null; returnedEventCount?:number;returnedMaterialCount?:number;grouping?:string }>("/api/v1/events" + params, { signal }),
  event: (id: string) => request<Event>("/api/v1/events/" + encodeURIComponent(id)),
  exposures: (items: {eventId: string; contentVersion: number}[]) => request<{recorded: number; skipped: number}>("/api/v1/events/exposures", { method: "POST", body: JSON.stringify({ items }) }),
  explore: (params: string) => request<Exploration>("/api/v1/explore?" + params),
  brief: (date = "today") => request<Brief>("/api/v1/briefs/" + encodeURIComponent(date)),
  briefs: () => request<{ items: BriefHistory[] }>("/api/v1/briefs"),
  saveBrief: () => request<Brief>("/api/v1/briefs/today/generate", { method: "POST", body: "{}" }),
  runtime: () => request<Runtime>("/api/v1/runtime"),
  readerStatus: () => request<ReaderStatus>("/api/v1/reader-status"),
  saveReaderSettings: (settings: ReaderSettings) => request<ReaderSettings>("/api/v1/reader-settings", { method: "PUT", body: JSON.stringify(settings) }),
  topics: () => request<{ items: Topic[] }>("/api/v1/me/interests"),
  saveTopics: (topics: Topic[]) => request<{ items: Topic[] }>("/api/v1/me/interests", { method: "PUT", body: JSON.stringify({ topics }) }),
  sources: () => request<{ items: Source[] }>("/api/v1/sources"),
  xPostUrls: (id:string) => request<{urls:string[]}>("/api/v1/sources/" + encodeURIComponent(id) + "/x-posts"),
  saveXPostUrls: (id:string,urls:string[]) => request<{urls:string[]}>("/api/v1/sources/" + encodeURIComponent(id) + "/x-posts", {method:"PUT",body:JSON.stringify({urls})}),
  sourceCoverage: () => request<{ items: SourceCoverage[] }>("/api/v1/sources/coverage"),
  sourceWatchlist: () => request<{items:SourceWatch[]}>("/api/v1/source-watchlist"),
  weekly: (date?:string) => request<Brief>("/api/v1/weekly"+(date?"?date="+encodeURIComponent(date):"")),
  // Earlier releases could publish share links; they stay readable until the owner revokes them.
  shareLinks: () => request<{items:ShareLink[]}>("/api/v1/shares"),
  publicShare: (id:string) => request<ShareDocument>("/api/v1/public/shares/"+encodeURIComponent(id)),
  revokeShare: (id:string) => request<{id:string;published:boolean;revoked:boolean}>("/api/v1/shares/"+encodeURIComponent(id),{method:"DELETE"}),
  addSource: (source: NewSource) => request<Source>("/api/v1/sources", { method: "POST", body: JSON.stringify(source) }),
  updateSource: (id: string, value: { enabled?: boolean; scheduleMinutes?: number; confirmed?: boolean }) => request<Source>("/api/v1/sources/" + encodeURIComponent(id), { method: "PUT", body: JSON.stringify(value) }),
  refreshSources: () => collect("/api/v1/admin/ingestion/run"),
  refreshSource: (id: string) => collect("/api/v1/sources/" + encodeURIComponent(id) + "/refresh"),
  providers: () => request<{ items: Provider[] }>("/api/v1/model-providers"),
  processing: () => request<Processing>("/api/v1/processing"),
  saveProcessingSettings: (settings: ProcessingSettings) => request<ProcessingSettings>("/api/v1/processing/settings", { method: "PUT", body: JSON.stringify(settings) }),
  retryProcessing: () => request<{ queued: number }>("/api/v1/processing/retry", { method: "POST" }),
  connectLocalCopilot: () => request<{ status: string }>("/api/v1/model-providers/github-copilot/local", { method: "POST" }),
  probeCopilot: () => request<{ status: string }>("/api/v1/model-providers/github-copilot/probe", { method: "POST" }),
  disconnectCopilot: () => request<{ status: string }>("/api/v1/model-providers/github-copilot", { method: "DELETE" }),
  eventState: (id: string, value: EventState) => request<Event>("/api/v1/events/" + encodeURIComponent(id) + "/state", { method: "PUT", body: JSON.stringify(value) }),
  summarize: (id: string, model: string) => request<Event>("/api/v1/events/" + encodeURIComponent(id) + "/summarize", { method: "POST", body: JSON.stringify({ model }) }),
};
