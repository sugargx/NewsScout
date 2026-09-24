use crate::{
    ingestion::{supported_adapters, validate_adapter_endpoint},
    models::Source,
};
use serde_json::{Value, json};

fn topic(source: &Source, labels: &[&str]) -> bool {
    source
        .topics
        .iter()
        .any(|topic| labels.iter().any(|label| topic.eq_ignore_ascii_case(label)))
}

pub fn coverage(sources: &[Source]) -> Value {
    let eligible: Vec<_> = sources
        .iter()
        .filter(|source| {
            matches!(source.lifecycle_status.as_str(), "stable" | "observing")
                && supported_adapters().contains(&source.adapter.as_str())
                && validate_adapter_endpoint(&source.adapter, &source.endpoint).is_ok()
        })
        .collect();
    let groups: [(&str, &str, fn(&Source) -> bool, &str); 19] = [
        (
            "reddit",
            "Reddit 原始社区帖子",
            |s| {
                s.endpoint.starts_with("https://www.reddit.com/r/") && s.endpoint.ends_with("/.rss")
            },
            "原站公开 Atom；社区讨论不是官方公告或独立编辑报道，不按多方新闻互证加热度。原站限流会显示实际失败，不通过镜像绕过。",
        ),
        (
            "chinese-ai-news",
            "中文 AI 媒体 · 官网 RSS",
            |s| {
                s.endpoint.starts_with("https://www.qbitai.com/")
                    || s.endpoint == "https://aiera.com.cn/feed/"
            },
            "量子位与新智元的官网公开 RSS，与公众号自动监听不同；只处理来源提供的摘录，不采集站内自动聚合面板。",
        ),
        (
            "author-blogs",
            "作者与专业出版 · 原始博客",
            |s| {
                s.content_type == "blog"
                    && (s.tier == "T1.5"
                        || s.endpoint == "https://simonwillison.net/atom/entries/"
                        || s.endpoint == "https://karpathy.bearblog.dev/feed/")
            },
            "作者和专业出版物的原始 Feed，不使用聚合平台的改写摘要；作者分析不等于已独立核验的事实。",
        ),
        (
            "official-blogs",
            "公司与研究机构 Blog",
            |s| s.content_type == "blog" && s.tier == "T1",
            "官方 Feed 与经核验站点目录；原文摘录不是 AI 摘要。",
        ),
        (
            "anthropic",
            "Anthropic 官方 News / Research / Engineering",
            |s| {
                matches!(
                    s.adapter.as_str(),
                    "anthropic_news" | "anthropic_research" | "anthropic_engineering"
                )
            },
            "三个独立官方索引仅提供标题、原始日期、主题和来源短摘录；每次请求先核验 robots，结构或政策变化即报错，不抓文章全文或分页。索引当前可用不等于近 30 天完整覆盖；200 条上限和索引自身收录范围均可能限制覆盖。",
        ),
        (
            "papers-ai",
            "AI 研究论文",
            |s| s.adapter == "arxiv_atom" && topic(s, &["AGI", "Agent"]),
            "arXiv 分类查询每日刷新，保留论文 ID/version 与原始日期；预印本不等于经过同行评审的结论。",
        ),
        (
            "papers-hci",
            "HCI 研究论文",
            |s| s.adapter == "arxiv_atom" && topic(s, &["HCI"]),
            "arXiv cs.HC 查询；研究发现须人工复核，不以发现时间替代投稿时间。",
        ),
        (
            "open-models",
            "Hugging Face / 开源模型",
            |s| s.adapter == "huggingface_models",
            "仅监听精选公开组织或模型的 ID、revision、创建和修改日期；不抓 gated 模型、权重或伪造 model card，尚无能力评测与趋势时间序列。",
        ),
        (
            "agent",
            "Agent / Context 工程",
            |s| topic(s, &["Agent", "Context", "Microsoft Agent Framework"]),
            "框架官方 Blog、Release 与公开仓库元数据互补；仓库更新不是新版本发布。",
        ),
        (
            "memory",
            "Memory",
            |s| topic(s, &["Memory"]),
            "精选 Memory 项目的公开 Release；项目自述需要进一步验证。",
        ),
        (
            "mcp",
            "MCP / A2A",
            |s| topic(s, &["MCP / A2A"]),
            "MCP SDK Release 与独立观察查询；A2A 独立来源仍有覆盖缺口。",
        ),
        (
            "rust",
            "Rust / Developer",
            |s| topic(s, &["Rust", "编程语言", "AI Coding"]),
            "语言官方 Blog 与已核验开发者来源；非所有语言生态的完整覆盖。",
        ),
        (
            "psychology",
            "心理学",
            |s| topic(s, &["心理学", "Psychology"]),
            "心理科学专业机构 Feed；研究报道并非个体诊断或医疗建议。",
        ),
        (
            "hci",
            "HCI",
            |s| topic(s, &["HCI"]),
            "HCI 论文和专业设计内容；尚未接入完整会议论文与引用网络。",
        ),
        (
            "design",
            "Design",
            |s| topic(s, &["Design"]),
            "专业设计出版物与开发者设计相关动态。",
        ),
        (
            "podcast",
            "中文 / 英文 Podcast",
            |s| s.adapter == "podcast_rss",
            "canonical RSS 的节目说明、GUID、发布时间与 enclosure 元数据；不下载音频，不抓第三方 transcript。",
        ),
        (
            "podcast-zhang",
            "张小珺Jùn｜商业访谈录",
            |s| {
                s.adapter == "podcast_rss"
                    && s.endpoint.trim_end_matches('/') == "https://feed.xyzfm.space/dk4yh3pkpjp3"
            },
            "Apple 公开目录与 canonical RSS 的节目名、作者、官网已交叉核验；来源仍需观察期确认。",
        ),
        (
            "github-monitor",
            "GitHub 已知项目监听",
            |s| {
                matches!(
                    s.adapter.as_str(),
                    "github_repository" | "github_release_atom"
                )
            },
            "精选项目 Release 与仓库 API；公共未认证 API 保守调度并遵守限流退避。",
        ),
        (
            "github-discovery",
            "GitHub 项目发现（观察）",
            |s| s.adapter == "github_search",
            "公开 Search API 候选，不是官方 Trending，不授予官方来源身份，不把 star 或榜单排名当作事实热度。",
        ),
    ];
    let mut items = Vec::new();
    for (id, label, matches, note) in groups {
        let selected: Vec<_> = eligible
            .iter()
            .copied()
            .filter(|source| matches(source))
            .collect();
        let observing = selected
            .iter()
            .filter(|source| source.lifecycle_status == "observing")
            .count();
        let healthy = selected
            .iter()
            .filter(|source| {
                source.last_success_at.is_some()
                    && source.consecutive_failures == 0
                    && source.last_error.is_none()
            })
            .count();
        let count = selected.len();
        let anthropic_adapters = [
            "anthropic_news",
            "anthropic_research",
            "anthropic_engineering",
        ];
        let missing_anthropic_index = id == "anthropic"
            && anthropic_adapters
                .iter()
                .any(|adapter| !selected.iter().any(|source| source.adapter == *adapter));
        let status = if count == 0 {
            "blocked"
        } else if observing > 0
            || healthy < count
            || missing_anthropic_index
            || matches!(id, "github-discovery" | "mcp")
        {
            "partial"
        } else {
            "active"
        };
        let mut item = json!({
            "id":id, "label":label, "status":status, "sourceCount":count,
            "message":format!("{count} 个启用来源，{observing} 个观察中，{healthy} 个最近采集成功。{note}")
        });
        if id == "anthropic" {
            item["indexAvailability"] = json!(anthropic_adapters.iter().map(|adapter| {
                let registered = selected.iter().filter(|source| source.adapter == *adapter).count();
                let successful = selected.iter().filter(|source| source.adapter == *adapter
                    && source.last_success_at.is_some() && source.consecutive_failures == 0
                    && source.last_error.is_none()).count();
                json!({"adapter":adapter, "sourceCount":registered, "healthySourceCount":successful})
            }).collect::<Vec<_>>());
            item["windowDays"] = json!(30);
            item["windowCompleteness"] = json!("not_verified");
        }
        items.push(item);
    }
    items.push(json!({
        "id":"builders", "label":"个人 Builder Watchlist", "status":"blocked", "sourceCount":0,
        "message":"具体作者、频道、社区及资料目录在关注名单中记录，并分别标识关联订阅或接入缺口；作者博客订阅不等于社交时间线监听。"
    }));
    let x_sources = sources
        .iter()
        .filter(|source| {
            source.adapter == "x_public_preview" && source.lifecycle_status != "paused"
        })
        .count();
    items.push(json!({
        "id":"x", "label":"X 公开原帖预览", "status":if x_sources>0 {"partial"} else {"blocked"}, "sourceCount":x_sources,
        "message":format!("{x_sources} 个登记原帖的来源；通过官方 oEmbed 读取有限预览。只更新已登记链接，不自动扫描主页、不代表完整或最新时间线；可在来源卡片中补充原帖链接。"),
        "coverage":"registered_posts_only"
    }));
    items.push(json!({
        "id":"wechat", "label":"微信公众号自动监听", "status":"blocked", "sourceCount":0,
        "message":"目录提供量子位和新智元官网 RSS，但不等于公众号自动监听。其他公众号仍需逐个核实作者官网同步页、原始 RSS 或授权入口；不使用聚合平台的改写摘要代替原始来源。"
    }));
    for (id, label) in [("weibo", "微博账号"), ("bilibili", "B站 UP 主")] {
        items.push(json!({"id":id,"label":label,"status":"blocked","sourceCount":0,
            "message":"原始推荐账号已列入关注名单；尚无已启用的平台采集适配器，不代表已执行平台关注或采集其动态。"}));
    }
    json!({"items":items})
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn source() -> Source {
        Source {
            id: Uuid::nil(),
            name: "Psychology".into(),
            publisher: "Professional publisher".into(),
            content_type: "blog".into(),
            adapter: "rss".into(),
            endpoint: "https://example.com/feed".into(),
            tier: "T1.5".into(),
            lifecycle_status: "observing".into(),
            topics: vec!["心理学".into()],
            last_success_at: None,
            schedule_minutes: 180,
            consecutive_failures: 0,
            last_error: None,
        }
    }

    fn item(value: &Value, id: &str) -> Value {
        value["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == id)
            .unwrap()
            .clone()
    }

    #[test]
    fn coverage_counts_real_enabled_sources_and_exposes_observation_health() {
        let mut first = source();
        let mut paused = source();
        paused.lifecycle_status = "paused".into();
        let report = coverage(&[first.clone(), paused]);
        let ids: std::collections::HashSet<_> = report["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), report["items"].as_array().unwrap().len());
        assert_eq!(item(&report, "psychology")["sourceCount"], 1);
        assert_eq!(item(&report, "psychology")["status"], "partial");
        assert_eq!(item(&report, "x")["sourceCount"], 0);
        first.lifecycle_status = "stable".into();
        first.last_success_at = Some(chrono::Utc::now());
        assert_eq!(item(&coverage(&[first]), "psychology")["status"], "active");
        assert_eq!(item(&coverage(&[]), "psychology")["status"], "blocked");
    }

    #[test]
    fn x_registered_previews_never_claim_full_timeline_coverage() {
        let mut preview = source();
        preview.adapter = "x_public_preview".into();
        preview.endpoint = "https://x.com/karpathy".into();
        preview.lifecycle_status = "stable".into();
        preview.last_success_at = Some(chrono::Utc::now());
        let report = item(&coverage(&[preview]), "x");
        assert_eq!(report["sourceCount"], 1);
        assert_eq!(report["status"], "partial");
        assert_eq!(report["coverage"], "registered_posts_only");
    }

    #[test]
    fn anthropic_coverage_counts_three_exact_adapters_without_claiming_window_completeness() {
        let mut sources = Vec::new();
        for path in ["news", "research", "engineering"] {
            let mut source = source();
            source.adapter = format!("anthropic_{path}");
            source.endpoint = format!("https://www.anthropic.com/{path}");
            source.lifecycle_status = "stable".into();
            source.last_success_at = Some(chrono::Utc::now());
            sources.push(source);
        }
        assert_eq!(
            item(&coverage(&sources[..1]), "anthropic")["status"],
            "partial"
        );
        let mut wrong_host = sources[1].clone();
        wrong_host.endpoint = "https://example.com/research".into();
        sources.push(wrong_host);
        let mut wrong_adapter = sources[2].clone();
        wrong_adapter.adapter = "anthropic_unverified".into();
        sources.push(wrong_adapter);
        let report = item(&coverage(&sources), "anthropic");
        assert_eq!(report["sourceCount"], 3);
        assert_eq!(report["status"], "active");
        assert_eq!(report["indexAvailability"].as_array().unwrap().len(), 3);
        assert!(
            report["indexAvailability"]
                .as_array()
                .unwrap()
                .iter()
                .all(|index| index["sourceCount"] == 1 && index["healthySourceCount"] == 1)
        );
        assert_eq!(report["windowDays"], 30);
        assert_eq!(report["windowCompleteness"], "not_verified");
        assert!(
            report["message"]
                .as_str()
                .unwrap()
                .contains("不等于近 30 天完整覆盖")
        );
    }
}
