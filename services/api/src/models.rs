use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Aggregation {
    pub name: String,
    pub url: String,
    pub original_source: String,
    #[serde(default)]
    pub expired: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub id: Uuid,
    pub source_name: String,
    pub source_tier: String,
    pub title: String,
    pub url: String,
    pub is_official: bool,
    pub published_at: DateTime<Utc>,
    #[serde(default)]
    pub original_published_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub publication_precision: Option<String>,
    #[serde(default)]
    pub collected_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub excerpt: String,
    #[serde(default)]
    pub technical_basis: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aggregation: Option<Aggregation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reading_context: Option<crate::reading_context::ReadingContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreBreakdown {
    pub source_quality: f32,
    pub corroboration: f32,
    pub freshness: f32,
    pub relevance: f32,
    pub novelty: f32,
    pub engagement: f32,
    pub editorial_boost: f32,
    pub total: f32,
    pub explanation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editorial: Option<Editorial>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_title: Option<String>,
    #[serde(default)]
    pub not_interested_reason: Option<NotInterestedReason>,
    #[serde(skip)]
    pub editorial_publishers: Vec<String>,
    #[serde(skip)]
    pub editorial_community: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coverage: Option<CoverageBundle>,
    pub id: Uuid,
    pub title: String,
    pub summary: String,
    pub importance: String,
    pub primary_topic: String,
    pub topics: Vec<String>,
    pub event_type: String,
    pub first_seen_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub published_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub freshness_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub publication_precision: Option<String>,
    #[serde(default)]
    pub collected_at: Option<DateTime<Utc>>,
    pub evidence: Vec<Evidence>,
    pub score: ScoreBreakdown,
    pub personal_relevance: f32,
    pub personal_reason: String,
    pub saved: bool,
    pub read: bool,
    #[serde(default)]
    pub later: bool,
    #[serde(default = "feed_summary")]
    pub summary_kind: String,
    #[serde(default)]
    pub summary_model: Option<String>,
    #[serde(default)]
    pub summarized_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub summary_evidence_ids: Vec<Uuid>,
    #[serde(default)]
    pub content_version: i64,
    #[serde(default)]
    pub summary_status: Option<String>,
    #[serde(default)]
    pub summary_error: Option<String>,
    #[serde(default)]
    pub summary_next_attempt_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub summary_format_version: i32,
    #[serde(default)]
    pub summary_reasoning_effort: Option<String>,
    #[serde(default)]
    pub summary_points: Vec<String>,
    #[serde(default)]
    pub summary_material_limit: Option<String>,
    #[serde(default)]
    pub summary_limitations: Vec<String>,
    #[serde(default)]
    pub not_interested: bool,
    #[serde(default)]
    pub seen: bool,
    #[serde(default)]
    pub opened: bool,
    #[serde(default)]
    pub recommendation: Option<Recommendation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageMember {
    pub event_id: Uuid,
    pub content_version: i64,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_title: Option<String>,
    pub event_type: String,
    pub published_at: Option<DateTime<Utc>>,
    pub publication_precision: Option<String>,
    pub summary_kind: String,
    pub summary: String,
    pub summary_points: Vec<String>,
    pub summary_material_limit: Option<String>,
    pub summary_limitations: Vec<String>,
    pub summary_model: Option<String>,
    pub summarized_at: Option<DateTime<Utc>>,
    pub evidence: Vec<Evidence>,
    pub relationship: String,
    pub material_kind: String,
    pub matches_filters: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageBundle {
    pub key: String,
    pub topic: String,
    pub relation: String,
    pub method: String,
    pub window_hours: i64,
    pub material_count: usize,
    pub news_material_count: usize,
    pub editorial_source_count: usize,
    pub official_source_count: usize,
    pub community_material_count: usize,
    pub popularity_boost: f32,
    pub members: Vec<CoverageMember>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recommendation {
    #[serde(default)]
    pub material_penalty: f32,
    pub score: f32,
    pub freshness: f32,
    pub affinity: f32,
    pub novelty_penalty: f32,
    pub facets: Vec<String>,
    pub source_confirmed: bool,
    pub explanation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Exposure {
    pub event_id: Uuid,
    pub content_version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExposureInput {
    pub items: Vec<Exposure>,
}
fn feed_summary() -> String {
    "feed".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub id: String,
    pub label: String,
    pub group: String,
    pub weight: i32,
    pub context: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: Uuid,
    pub name: String,
    pub publisher: String,
    pub content_type: String,
    pub adapter: String,
    pub endpoint: String,
    pub tier: String,
    pub lifecycle_status: String,
    pub topics: Vec<String>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub schedule_minutes: i32,
    #[serde(default)]
    pub consecutive_failures: i32,
    #[serde(default)]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyBrief {
    #[serde(default)]
    pub sections: Vec<BriefSection>,
    pub local_date: String,
    pub generated_at: DateTime<Utc>,
    pub estimated_minutes: i32,
    pub items: Vec<Event>,
    pub is_snapshot: bool,
    pub window_start: DateTime<Utc>,
    pub window_end: DateTime<Utc>,
    #[serde(default)]
    pub primary_window_start: Option<DateTime<Utc>>,
    #[serde(default)]
    pub selection_note: Option<String>,
    #[serde(default)]
    pub eligibility: Option<BriefEligibility>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Editorial {
    pub policy_version: String,
    pub content_kind: String,
    pub value_score: f32,
    pub reason: String,
    pub brief_eligible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefSection {
    pub key: String,
    pub kind: String,
    pub title: String,
    pub description: String,
    pub event_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotInterestedReason {
    Topic,
    Source,
    Old,
    LowValue,
}

impl NotInterestedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Topic => "topic",
            Self::Source => "source",
            Self::Old => "old",
            Self::LowValue => "low_value",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefEligibility {
    pub window_candidates: i64,
    pub awaiting_summary: i64,
    pub awaiting_source_confirmation: i64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefHistory {
    pub local_date: NaiveDate,
    pub generated_at: DateTime<Utc>,
    pub item_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: String,
    pub connected: bool,
    pub eligible: bool,
    pub model: Option<String>,
    pub message: String,
    pub models: Vec<String>,
    pub verified_at: Option<DateTime<Utc>>,
    pub auth_mode: Option<String>,
    pub account_login: Option<String>,
    pub preferred_model: String,
    pub oauth_configured: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventQuery {
    pub interests: Option<crate::visitor_interests::VisitorInterests>,
    pub coverage: Option<bool>,
    pub include_engineering: Option<bool>,
    pub technical: Option<bool>,
    pub tier: Option<String>,
    pub kind: Option<String>,
    pub source: Option<Uuid>,
    pub opened: Option<bool>,
    pub topic: Option<String>,
    pub q: Option<String>,
    pub saved: Option<bool>,
    pub read: Option<bool>,
    pub later: Option<bool>,
    pub sort: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub hours: Option<i64>,
    pub facet: Option<String>,
    pub not_interested: Option<bool>,
    pub as_of: Option<DateTime<Utc>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisitorQuery {
    pub interests: Option<crate::visitor_interests::VisitorInterests>,
    pub as_of: Option<DateTime<Utc>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventStateInput {
    pub saved: Option<bool>,
    pub read: Option<bool>,
    pub later: Option<bool>,
    pub not_interested: Option<bool>,
    pub not_interested_reason: Option<NotInterestedReason>,
    pub opened: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterestInput {
    pub topics: Vec<Topic>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceInput {
    pub name: String,
    pub endpoint: String,
    pub adapter: String,
    pub content_type: String,
    pub tier: String,
    pub schedule_minutes: i32,
    pub topic: Option<String>,
    pub original_post_urls: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceUpdate {
    pub enabled: Option<bool>,
    pub schedule_minutes: Option<i32>,
    pub confirmed: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedSummary {
    #[serde(default)]
    pub display_title: Option<String>,
    #[serde(skip_deserializing, default)]
    pub summary: String,
    pub points: Vec<String>,
    pub material_limit: Option<String>,
    pub limitations: Vec<String>,
    pub importance: String,
    pub evidence_ids: Vec<Uuid>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SummarizeInput {
    pub model: String,
}
