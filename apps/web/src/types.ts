export interface ReadingContext {
  version:number;kind:"article"|"post"|"podcast"|"release"|"feed";
  origin:"feed"|"publisher_page"|"authorized_api";
  status:"available"|"partial"|"unavailable"|"blocked";
  sourceUrl:string;body:string;truncated:boolean;durationSeconds:number|null;
  chapters:{startSeconds:number;title:string;url:string|null}[];
  transcriptUrl:string|null;
  comments:{id:string;body:string;score:number|null;url:string|null;author?:string|null;publishedAt?:string|null;truncated?:boolean}[];
  commentsStatus:"not_applicable"|"requires_authorization"|"not_fetched"|"available";
  fetchedAt:string|null;
}
export interface Evidence { id: string; sourceName: string; sourceTier: string; title: string; url: string; isOfficial: boolean; publishedAt: string | null; originalPublishedAt?: string | null; publicationPrecision?: "day" | "time" | null; collectedAt?: string | null; excerpt: string; readingContext?:ReadingContext|null; technicalBasis?:string|null; aggregation?: {name:string;url:string;originalSource:string;expired?:boolean} }
export interface SummaryPresentation { points:string[];materialLimit:string|null;limitations:string[] }
export interface Score { sourceQuality: number; corroboration: number; freshness: number; relevance: number; novelty: number; engagement: number; editorialBoost: number; total: number; explanation: string }
export type SummaryStatus = "pending" | "running" | "completed" | "failed";
export interface Recommendation { score: number; freshness: number; affinity: number; noveltyPenalty: number; facets: string[]; sourceConfirmed: boolean; explanation: string; materialPenalty?:number }
export interface CoverageMember {
  eventId:string;contentVersion:number;title:string;displayTitle?:string|null;eventType:string;publishedAt:string|null;
  publicationPrecision:"day"|"time"|null;summaryKind:Event["summaryKind"];summary:string;
  summaryPoints:string[];summaryMaterialLimit:string|null;summaryLimitations:string[];
  summaryModel:string|null;summarizedAt:string|null;evidence:Evidence[];
  relationship:"lead"|"same_named_topic"|"shared_identifier"|"same_event_evidence"|"release_family"|"archived_material";materialKind:"editorial"|"official"|"community";matchesFilters:boolean;
  releaseTarget?:string|null;releaseVersion?:string|null;
  hidden?:boolean; // Client-only feedback overlay; not part of the server/public projection.
}
export interface CoverageBundle {
  key:string;topic:string;relation:"same_named_topic"|"shared_identifier"|"same_event_evidence"|"release_family"|"archived_materials";method:"deterministic-name-v1"|"release-family-v1"|"release-family-v2"|"exact-event-reference-v1"|"archived-materials-v1";windowHours:number;
  materialCount:number;newsMaterialCount:number;editorialSourceCount:number;officialSourceCount:number;
  communityMaterialCount:number;popularityBoost:number;members:CoverageMember[];
}
export interface Event {
  displayTitle?:string|null;
  editorial?:Editorial;
  notInterestedReason?:NotInterestedReason|null;
  coverage?:CoverageBundle|null;
  id: string; contentVersion: number; title: string; summary: string; importance: string;
  primaryTopic: string; topics: string[]; eventType: string; firstSeenAt: string; updatedAt: string;
  publishedAt?: string | null; freshnessAt?:string|null; publicationPrecision?: "day" | "time" | null; collectedAt?: string | null;
  summaryFormatVersion?: number; summaryReasoningEffort?: string | null;
  summaryPoints?:string[]; summaryMaterialLimit?:string|null; summaryLimitations?:string[];
  evidence: Evidence[]; score: Score; personalRelevance: number; personalReason: string;
  saved: boolean; read: boolean; later: boolean; notInterested: boolean; seen: boolean; opened: boolean;
  recommendation?: Recommendation | null; summaryKind: "feed" | "copilot" | "demo"; summaryModel: string | null;
  summarizedAt: string | null; summaryEvidenceIds: string[]; summaryStatus?: SummaryStatus | null;
  summaryError?: string | null; summaryNextAttemptAt?: string | null;
}
export interface Topic { id: string; label: string; group: string; weight: number; context: string; enabled: boolean }
export interface Source { id: string; name: string; publisher: string; contentType: string; adapter: string; endpoint: string; tier: string; lifecycleStatus: string; topics: string[]; lastSuccessAt?: string | null; scheduleMinutes: number; consecutiveFailures: number; lastError: string | null }
export interface SourceCoverage { id: string; label: string; status: "active" | "partial" | "blocked"; sourceCount: number; message: string }
export interface ProcessingSettings { enabled: boolean; model: string; dailyLimit: number }
export interface ProcessingJob { eventId: string; title: string; status: SummaryStatus; model: string | null; attempts: number; lastError: string | null; nextAttemptAt: string | null }
export interface Processing { settings: ProcessingSettings; counts: { pending: number; running: number; failed: number; completed: number }; usage: { used: number; limit: number; resetsAt: string | null }; blockedReason: "disabled" | "demo" | "isolated" | "account" | "model" | "quota" | null; feedCount: number; aiCount: number; jobs: ProcessingJob[] }
export interface Provider { provider: string; connected: boolean; eligible: boolean; model: string | null; message: string; models: string[]; verifiedAt: string | null; authMode: "local" | "oauth" | null; accountLogin: string | null; preferredModel: string; oauthConfigured: boolean }
export interface Runtime { mode: "demo" | "postgres"; timeZone: "Asia/Shanghai"; version: string }
export interface ReaderSession {
  user: { id: string; displayName: string };
  capabilities: { manageReadingSettings: boolean };
  csrfToken: string;
  telemetryConsent: boolean;
}
export type NotInterestedReason = "topic"|"source"|"old"|"low_value";
export interface Editorial {policyVersion:string;contentKind:"news"|"release"|"research"|"analysis"|"tutorial"|"discussion"|"question"|"promotion"|"metadata";valueScore:number;reason:string;briefEligible:boolean}
export interface BriefSection {key:string;kind:"essential"|"catch_up"|"more"|"topic";title:string;description:string;eventIds:string[]}
export interface Brief { localDate: string; generatedAt: string; estimatedMinutes: number; items: Event[]; sections?:BriefSection[]; isSnapshot: boolean; windowStart: string; windowEnd: string; primaryWindowStart?: string; selectionNote?: string; nextRefreshAt?: string | null; refreshPending?: boolean; eligibility?: { windowCandidates: number; awaitingSummary: number; awaitingSourceConfirmation: number } }
export interface ReaderSettings { mode: "daily" | "interval"; hour: number; includeObserving: boolean; briefLimit: number }
export interface ReaderStatus { settings: ReaderSettings; timeZone: "Asia/Shanghai"; nextCollectionAt: string | null; lastCollectionAt: string | null; latestPublishedAt: string | null; morningRun: { localDate: string; status: "collecting" | "summarizing" | "ready" | "partial" | "failed"; scheduledAt: string; startedAt: string; finishedAt: string | null; sourceSucceeded: number; sourceFailed: number; message: string | null } | null }
export interface BriefHistory { localDate: string; generatedAt: string; itemCount: number }
export interface EventState { saved?: boolean; read?: boolean; later?: boolean; notInterested?: boolean; notInterestedReason?:NotInterestedReason|null; opened?: boolean }
export interface NewSource { name: string; endpoint: string; adapter: "rss" | "atom" | "github_release_atom" | "podcast_rss" | "arxiv_atom" | "huggingface_models" | "github_repository" | "github_search" | "anthropic_news" | "anthropic_research" | "anthropic_engineering" | "x_public_preview"; contentType: "blog" | "release" | "podcast" | "paper" | "model" | "repository"; tier: "T1" | "T1.5" | "T2"; scheduleMinutes: number; topic?: string; originalPostUrls?:string[] }

export interface SourceWatch {
  id:string;platform:"x"|"wechat"|"podcast"|"blog"|"youtube"|"weibo"|"reddit"|"bilibili"|"collection"|"github"|"community";
  name:string;handle:string|null;profileUrl:string|null;status:string;note:string;
  sourceId?:string|null;originUrl?:string|null;originLabel?:string|null;originBlock?:string|null;
  documentUrls?:string[];
}
export interface ShareSource { name:string; url:string; tier:string }
export interface ShareItem { title:string; summary:string; publishedAt:string|null; sources:ShareSource[]; summaryKind:string }
export interface ShareDocument { title:string; kind:"event"|"brief"|"week"; date:string; createdAt:string; items:ShareItem[]; note:string }
export interface ShareLink { id:string; title:string; date:string; kind:string; createdAt:string; edited:boolean; published:boolean; revoked:boolean }
export interface IngestionResult { attempted: number; succeeded: number; failed: number; ingested: number; updated: number; errors?: unknown[] }
export interface Exploration { sampleSize: number; limit: number; nodes: {id: string; count: number}[]; edges: {source: string; target: string; count: number}[]; meaning: string }
