import type { Brief, BriefHistory, Event, EventState, Exploration, IngestionResult, NewSource, Processing, ProcessingSettings, Provider, ReaderSettings, ReaderStatus, Runtime, Source, SourceCoverage, Topic, SourceWatch, SharedEdition, ShareSettings, ShareEditor, ShareSelection } from "./types";

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("无法连接本地 API。请检查网络和 API 服务后重试。");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
    const message = typeof body?.error === "string" ? body.error : typeof body?.message === "string" ? body.message : "请求失败";
    throw new ApiError(`${message}（HTTP ${response.status}）`, response.status);
  }
  return response.json() as Promise<T>;
}

export const api = {
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
  createShare: (input:{kind:"event"|"brief"|"week";eventId?:string;date?:string;selection?:ShareSelection[]}) =>
    request<SharedEdition>("/api/v1/shares",{method:"POST",body:JSON.stringify(input)}),
  share: (id:string) => request<SharedEdition>("/api/v1/shares/"+encodeURIComponent(id)),
  shareDrafts:()=>request<{items:{id:string;title:string;date:string;kind:string;createdAt:string;edited:boolean}[]}>("/api/v1/shares"),
  saveShareDraft: (id:string,editor:ShareEditor) => request<SharedEdition>("/api/v1/shares/"+encodeURIComponent(id)+"/draft",{method:"PUT",body:JSON.stringify(editor)}),
  publishShare: (id:string) => request<SharedEdition>("/api/v1/shares/"+encodeURIComponent(id)+"/publish",{method:"POST"}),
  revokeShare: (id:string) => request<SharedEdition>("/api/v1/shares/"+encodeURIComponent(id),{method:"DELETE"}),
  shareSettings: () => request<ShareSettings>("/api/v1/share-settings"),
  saveShareSettings: (settings:ShareSettings) => request<ShareSettings>("/api/v1/share-settings",{method:"PUT",body:JSON.stringify(settings)}),
  addSource: (source: NewSource) => request<Source>("/api/v1/sources", { method: "POST", body: JSON.stringify(source) }),
  updateSource: (id: string, value: { enabled?: boolean; scheduleMinutes?: number; confirmed?: boolean }) => request<Source>("/api/v1/sources/" + encodeURIComponent(id), { method: "PUT", body: JSON.stringify(value) }),
  refreshSources: () => request<IngestionResult>("/api/v1/admin/ingestion/run", { method: "POST" }),
  refreshSource: (id: string) => request<IngestionResult>("/api/v1/sources/" + encodeURIComponent(id) + "/refresh", { method: "POST" }),
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
