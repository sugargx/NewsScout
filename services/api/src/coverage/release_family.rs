use std::collections::{BTreeSet, HashSet};

use chrono::{DateTime, Duration, Utc};
use uuid::Uuid;

use super::Record;
use crate::models::CoverageMember;

pub(super) const WINDOW_HOURS: i64 = 24;

#[derive(Clone)]
pub(super) struct Release {
    pub repo: String,
    pub key: String,
    pub target: String,
    pub version: String,
    product: Option<String>,
    repository: String,
    family_label: &'static str,
    target_key: String,
    client: bool,
    package: bool,
    grouping: Grouping,
    changes: BTreeSet<String>,
    subjects: BTreeSet<Subject>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Grouping {
    SharedChanges,
    ScopedBatch,
    LanguageWindow,
}

impl Release {
    /// Verified family releases always belong to their repository's window.
    pub(super) fn project(&self) -> super::project::ProjectRelease {
        super::project::ProjectRelease {
            key: self.repo.clone(),
            product: self.repository.clone(),
            target: self.target.clone(),
            version: self.version.clone(),
        }
    }

    pub(super) fn method(&self) -> &'static str {
        match self.grouping {
            Grouping::LanguageWindow => "project-release-window-v1",
            _ => "release-family-v2",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Subject {
    ClientIdentity,
    InstallAccounting,
    Telemetry,
}

impl Subject {
    fn label(self) -> &'static str {
        match self {
            Self::ClientIdentity => "调用来源标识",
            Self::InstallAccounting => "安装统计",
            Self::Telemetry => "遥测",
        }
    }
}

fn subjects(text: &str) -> BTreeSet<Subject> {
    let text = text.to_ascii_lowercase();
    let mut result = BTreeSet::new();
    if text.contains("surface-identity headers")
        || (text.contains("x-mem0-source") && text.contains("x-mem0-client"))
    {
        result.insert(Subject::ClientIdentity);
    }
    if text.contains("keyfingerprint") && text.contains("install") {
        result.insert(Subject::InstallAccounting);
    }
    if text.contains("telemetry") {
        result.insert(Subject::Telemetry);
    }
    result
}

fn normalized(value: &str) -> String {
    value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase()
}

fn version(value: &str) -> bool {
    let core = value.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<_> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
        && !value.ends_with(['-', '+', '.'])
}

fn client_target(value: &str) -> String {
    match normalized(value).as_str() {
        "node" | "nodejs" | "javascript" | "typescript" | "js" | "ts" => "node".into(),
        "py" | "python" => "python".into(),
        _ => normalized(value),
    }
}

fn client_tag_matches(tag: &str, target: &str, family: &str) -> bool {
    if (family == "sdk" && tag.is_empty()) || (family == "cli" && tag == "cli") {
        return true;
    }
    let tag = normalized(tag);
    let tag_target = tag
        .strip_prefix(family)
        .or_else(|| tag.strip_suffix(family))
        .unwrap_or(&tag);
    client_target(tag_target) == client_target(target)
}

fn package_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.'))
}

fn npm_identifier(value: &str) -> bool {
    package_name(value) && value.bytes().all(|byte| !byte.is_ascii_uppercase())
}

fn package_version(value: &str) -> bool {
    if !version(value) {
        return false;
    }
    let (without_build, build) = value
        .split_once('+')
        .map_or((value, None), |(version, build)| (version, Some(build)));
    let (core, prerelease) = without_build
        .split_once('-')
        .map_or((without_build, None), |(core, prerelease)| {
            (core, Some(prerelease))
        });
    let identifiers = |value: &str, allow_numeric_zeroes: bool| {
        value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && (allow_numeric_zeroes
                    || !part.bytes().all(|byte| byte.is_ascii_digit())
                    || part.len() == 1
                    || !part.starts_with('0'))
        })
    };
    core.split('.')
        .all(|part| part.len() == 1 || !part.starts_with('0'))
        && prerelease.is_none_or(|value| identifiers(value, false))
        && build.is_none_or(|value| identifiers(value, true))
}

fn decoded_scoped_tag(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            let value = std::str::from_utf8(hex).ok()?;
            match u8::from_str_radix(value, 16).ok()? {
                b'@' => decoded.push(b'@'),
                b'/' => decoded.push(b'/'),
                _ => return None,
            }
            index += 3;
            continue;
        }
        if !byte.is_ascii_alphanumeric() && !matches!(byte, b'@' | b'-' | b'_' | b'.' | b'+') {
            return None;
        }
        decoded.push(byte);
        index += 1;
    }
    String::from_utf8(decoded).ok()
}

fn scoped_package_release(repo: &str, repository: &str, tag: &str, title: &str) -> Option<Release> {
    let title = title.trim();
    let package_and_version = title.strip_prefix('@')?;
    let (package_identity, release_version) = package_and_version.rsplit_once('@')?;
    let (scope, package) = package_identity.split_once('/')?;
    if package_identity[scope.len() + 1..].contains('/')
        || !package_name(repository)
        || !npm_identifier(scope)
        || !npm_identifier(package)
        || !package_version(release_version)
        || decoded_scoped_tag(tag)?.as_str() != title
    {
        return None;
    }
    Some(Release {
        repo: repo.into(),
        key: format!("{repo}:npm-scope:{scope}:{release_version}"),
        product: Some(format!("@{scope}")),
        repository: repository.into(),
        family_label: "同批",
        target: package.into(),
        target_key: format!("npm:{package}"),
        client: false,
        package: true,
        grouping: Grouping::ScopedBatch,
        version: release_version.into(),
        changes: BTreeSet::new(),
        subjects: BTreeSet::new(),
    })
}

fn package_release(repo: &str, repository: &str, tag: &str, title: &str) -> Option<Release> {
    let (package, release_version) = title.trim().split_once("==")?;
    if !package_name(repository) || !package_name(package) || !package_version(release_version) {
        return None;
    }
    // Decode only the verified delimiter, once; never decode path separators or nested escapes.
    let tag = tag.replace("%3D", "=").replace("%3d", "=");
    if tag.contains('%') {
        return None;
    }
    let component = if let Some((component, tag_version)) = tag.split_once("==") {
        if !package_name(component)
            || tag_version != release_version
            || !package.eq_ignore_ascii_case(&format!("{repository}-{component}"))
        {
            return None;
        }
        Some(component.to_ascii_lowercase())
    } else {
        if tag != release_version || !package.eq_ignore_ascii_case(repository) {
            return None;
        }
        None
    };
    Some(Release {
        repo: repo.into(),
        key: format!("{repo}:package"),
        product: Some(repository.to_ascii_lowercase()),
        repository: repository.into(),
        family_label: "同批",
        target: match component.as_deref() {
            None => "核心包".into(),
            Some("sdk") => "SDK".into(),
            Some("cli") => "CLI".into(),
            Some(component) => component.into(),
        },
        target_key: component
            .map(|component| format!("component:{component}"))
            .unwrap_or_else(|| "core".into()),
        client: false,
        package: true,
        grouping: Grouping::SharedChanges,
        version: release_version.into(),
        changes: BTreeSet::new(),
        subjects: BTreeSet::new(),
    })
}

fn language_release(repo: &str, repository: &str, tag: &str, title: &str) -> Option<Release> {
    if title.trim() != tag || !package_name(repository) {
        return None;
    }
    let (language, release_version) = tag.split_once('-')?;
    let release_version = release_version.strip_prefix('v').unwrap_or(release_version);
    if !package_version(release_version) {
        return None;
    }
    let (target_key, target) = match language {
        "python" | "py" => ("python", "Python"),
        "dotnet" | "net" => ("dotnet", ".NET"),
        "java" => ("java", "Java"),
        "javascript" | "node" | "nodejs" | "js" => ("node", "JavaScript"),
        "typescript" | "ts" => ("node", "TypeScript"),
        "go" | "golang" => ("go", "Go"),
        "rust" => ("rust", "Rust"),
        "ruby" => ("ruby", "Ruby"),
        "php" => ("php", "PHP"),
        "swift" => ("swift", "Swift"),
        "kotlin" => ("kotlin", "Kotlin"),
        _ => return None,
    };
    let channel = if release_version.split('+').next()?.contains('-') {
        "preview"
    } else {
        "stable"
    };
    Some(Release {
        repo: repo.into(),
        key: format!("{repo}:language:{channel}"),
        product: Some(repository.into()),
        repository: repository.into(),
        family_label: "多语言",
        target: target.into(),
        target_key: target_key.into(),
        client: true,
        package: false,
        grouping: Grouping::LanguageWindow,
        version: release_version.into(),
        changes: BTreeSet::new(),
        subjects: BTreeSet::new(),
    })
}

fn legacy_release(repo: &str, repository: &str, tag: &str, title: &str) -> Option<Release> {
    let (target_tag, release_version) = tag
        .rsplit_once("-v")
        .or_else(|| tag.strip_prefix('v').map(|version| ("", version)))?;
    if !version(release_version) {
        return None;
    }
    let suffix = format!("(v{release_version})");
    let title = title.trim().strip_suffix(&suffix)?.trim();
    let mut words: Vec<_> = title.split_whitespace().collect();
    let family = words.pop()?.to_ascii_lowercase();
    let family_label = match family.as_str() {
        "plugin" => "插件",
        "extension" => "扩展",
        "adapter" => "适配器",
        "integration" => "集成",
        "cli" | "sdk" => "客户端",
        "provider"
            if words
                .last()
                .is_some_and(|word| word.eq_ignore_ascii_case("sdk")) =>
        {
            words.pop();
            "客户端"
        }
        _ => return None,
    };
    let client = matches!(family.as_str(), "cli" | "sdk" | "provider");
    let prefix = (1..words.len())
        .find(|length| normalized(&words[..*length].join(" ")) == normalized(repository));
    // A named SDK provider may identify its host instead of the repository product,
    // but its release tag must still identify that same host.
    if prefix.is_none() && family != "provider" {
        return None;
    }
    let product = prefix.map(|length| words[..length].join(" "));
    let target = words[prefix.unwrap_or(0)..].join(" ");
    if target.is_empty() {
        return None;
    }
    let tag_target = normalized(target_tag);
    let matches_tag = if client {
        client_tag_matches(target_tag, &target, &family)
    } else {
        tag_target == normalized(&target) || tag_target == normalized(&format!("{target}{family}"))
    };
    if !matches_tag {
        return None;
    }
    let target_key = if client {
        format!("{}:{family}", client_target(&target))
    } else {
        normalized(&target)
    };
    Some(Release {
        repo: repo.into(),
        key: format!("{repo}:{}", if client { "client" } else { &family }),
        product,
        repository: repository.into(),
        family_label,
        target: match family.as_str() {
            "cli" => format!("{target} CLI"),
            "sdk" => format!("{target} SDK"),
            "provider" => format!("{target} SDK Provider"),
            _ => target,
        },
        target_key,
        client,
        package: false,
        grouping: Grouping::SharedChanges,
        version: format!("v{release_version}"),
        changes: BTreeSet::new(),
        subjects: BTreeSet::new(),
    })
}

pub(super) fn parse(member: &CoverageMember) -> Option<Release> {
    parse_with(member, true)
}

/// Component identity for display and neutral headings only. Without change
/// references it can never support a shared-change or batch claim.
pub(super) fn identity(member: &CoverageMember) -> Option<Release> {
    parse_with(member, false)
}

fn parse_with(member: &CoverageMember, require_changes: bool) -> Option<Release> {
    if member.event_type != "release"
        || member.material_kind != "official"
        || member.publication_precision.as_deref() != Some("time")
    {
        return None;
    }
    let mut result: Option<Release> = None;
    for evidence in &member.evidence {
        if !evidence.is_official || evidence.original_published_at.is_none() {
            return None;
        }
        let url = url::Url::parse(&evidence.url).ok()?;
        if url.scheme() != "https"
            || url.host_str() != Some("github.com")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.port().is_some()
        {
            return None;
        }
        let segments: Vec<_> = url.path_segments()?.collect();
        let [owner, repository, "releases", "tag", tag] = segments.as_slice() else {
            return None;
        };
        let repo = format!("github.com/{owner}/{repository}").to_ascii_lowercase();
        let mut release = if evidence.title.starts_with('@') {
            if owner.is_empty()
                || !owner
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                || evidence.url != url.as_str()
            {
                return None;
            }
            scoped_package_release(&repo, repository, tag, &evidence.title)?
        } else if evidence.title.contains("==") {
            if owner.is_empty()
                || !owner
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                || evidence.url != url.as_str()
            {
                return None;
            }
            package_release(&repo, repository, tag, &evidence.title)?
        } else {
            language_release(&repo, repository, tag, &evidence.title)
                .or_else(|| legacy_release(&repo, repository, tag, &evidence.title))?
        };
        let mut changes = BTreeSet::new();
        for word in evidence.excerpt.split_whitespace() {
            let word = word.trim_matches(['(', ')', '[', ']', ',', '.', ';', '。']);
            if let Some(number) = word
                .strip_prefix('#')
                .filter(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            {
                changes.insert(format!("{repo}/change/{number}"));
            } else if let Ok(link) = url::Url::parse(word) {
                if link.scheme() == "https"
                    && link.host_str() == Some("github.com")
                    && link.username().is_empty()
                    && link.password().is_none()
                    && link.port().is_none()
                {
                    let path: Vec<_> = link.path_segments()?.collect();
                    if let [link_owner, link_repo, "pull" | "issues", number] = path.as_slice() {
                        if link_owner.eq_ignore_ascii_case(owner)
                            && link_repo.eq_ignore_ascii_case(repository)
                            && !number.is_empty()
                            && number.bytes().all(|b| b.is_ascii_digit())
                        {
                            changes.insert(format!("{repo}/change/{number}"));
                        }
                    }
                }
            }
        }
        if require_changes && (release.client || release.package) && changes.is_empty() {
            return None;
        }
        release.changes = changes;
        release.subjects = subjects(&evidence.excerpt);
        if let Some(previous) = &mut result {
            if previous.key != release.key
                || previous.target != release.target
                || previous.version != release.version
            {
                return None;
            }
            if release.package {
                previous.changes = previous
                    .changes
                    .intersection(&release.changes)
                    .cloned()
                    .collect();
                if require_changes && previous.changes.is_empty() {
                    return None;
                }
            } else {
                previous.changes.extend(release.changes);
            }
            previous.subjects = previous
                .subjects
                .intersection(&release.subjects)
                .copied()
                .collect();
        } else {
            result = Some(release);
        }
    }
    result
}

pub(super) fn label(members: &[&Record]) -> String {
    let releases: Vec<_> = members
        .iter()
        .filter_map(|record| record.release.as_ref())
        .collect();
    let first = releases[0];
    let product = releases
        .iter()
        .filter_map(|release| release.product.as_deref())
        .min()
        .unwrap_or(&first.repository);
    if first.grouping == Grouping::LanguageWindow {
        let names = releases
            .iter()
            .take(3)
            .map(|release| format!("{} {}", release.target, release.version))
            .collect::<Vec<_>>()
            .join(" / ");
        let subject = if releases.len() > 3 {
            format!("{names} 等{}项", releases.len())
        } else {
            names
        };
        return format!("{product} 多语言更新：{subject}");
    }
    if first.grouping == Grouping::ScopedBatch {
        let names = releases
            .iter()
            .take(3)
            .map(|release| release.target.as_str())
            .collect::<Vec<_>>()
            .join(" / ");
        let subject = if releases.len() > 3 {
            format!("{names} 等{}项", releases.len())
        } else {
            names
        };
        return format!("{product} {} 同批发布：{subject}", first.version);
    }
    if first.package {
        let mut components = releases.clone();
        components.sort_by(|a, b| {
            (a.target_key != "core")
                .cmp(&(b.target_key != "core"))
                .then(a.target_key.cmp(&b.target_key))
        });
        let names = components
            .iter()
            .take(2)
            .map(|release| format!("{} {}", release.target, release.version))
            .collect::<Vec<_>>()
            .join(" / ");
        let subject = if components.len() > 2 {
            format!("{names} 等{}项", components.len())
        } else {
            names
        };
        return format!("{product} {}更新：{subject}", first.family_label);
    }
    let common = releases
        .iter()
        .skip(1)
        .fold(first.subjects.clone(), |subjects, release| {
            subjects.intersection(&release.subjects).copied().collect()
        });
    let subject = if let Some(subject) = common.first() {
        subject.label().to_owned()
    } else {
        let targets: BTreeSet<_> = releases
            .iter()
            .map(|release| release.target.as_str())
            .collect();
        let names = targets
            .iter()
            .take(2)
            .copied()
            .collect::<Vec<_>>()
            .join(" / ");
        if targets.len() > 2 {
            format!("{names} 等{}项", targets.len())
        } else {
            names
        }
    };
    format!("{product} {}更新：{subject}", first.family_label)
}

pub(super) const PROJECT_WINDOW_METHOD: &str = "project-release-window-v2";

/// A repository window keeps the stricter family heading only when every member
/// still forms one verified batch; otherwise the heading is a neutral roundup.
pub(super) fn window(
    members: &[&Record],
    cutoff: DateTime<Utc>,
) -> (String, String, &'static str) {
    if let Some(releases) = members
        .iter()
        .map(|record| record.release.as_ref())
        .collect::<Option<Vec<_>>>()
    {
        let first = releases[0];
        if releases.iter().all(|release| release.key == first.key) {
            let strict = cohorts(members, cutoff);
            if strict.len() == 1 && strict[0].len() == members.len() {
                return (first.key.clone(), label(members), first.method());
            }
        }
    }
    let key = members[0]
        .project
        .as_ref()
        .map(|project| project.key.clone())
        .unwrap_or_default();
    (key, project_label(members), PROJECT_WINDOW_METHOD)
}

fn project_label(members: &[&Record]) -> String {
    let repository = members[0]
        .project
        .as_ref()
        .map(|project| project.product.clone())
        .unwrap_or_default();
    let mut items: Vec<_> = members
        .iter()
        .map(|record| {
            (
                record.identity.as_ref().map(|release| release.target_key.clone()),
                record.member.release_target.clone().unwrap_or_default(),
                record.member.release_version.clone().unwrap_or_default(),
            )
        })
        .collect();
    // Identities only choose neutral nouns; shared-change titles were decided by `window`.
    let releases: Option<Vec<_>> = members.iter().map(|record| record.identity.as_ref()).collect();
    let (product, mut noun) = match &releases {
        Some(releases) => {
            let products: BTreeSet<_> = releases
                .iter()
                .filter_map(|release| release.product.as_deref())
                .map(normalized)
                .collect();
            let product = if products.len() == 1 {
                releases
                    .iter()
                    .filter_map(|release| release.product.clone())
                    .min()
                    .unwrap_or_else(|| repository.clone())
            } else {
                repository.clone()
            };
            let first = releases[0];
            let noun = if releases
                .iter()
                .all(|release| release.grouping == Grouping::LanguageWindow)
            {
                "多语言更新".to_owned()
            } else if releases.iter().all(|release| release.package) {
                // Same-scope or same-repository packages are components, not a verified batch.
                items.sort_by(|a, b| {
                    (a.0.as_deref() != Some("core"))
                        .cmp(&(b.0.as_deref() != Some("core")))
                        .then(a.0.cmp(&b.0))
                });
                "组件更新".to_owned()
            } else if releases.iter().all(|release| {
                !release.package
                    && release.grouping != Grouping::LanguageWindow
                    && release.family_label == first.family_label
            }) {
                format!("{}更新", first.family_label)
            } else {
                "版本更新".to_owned()
            };
            (product, noun)
        }
        None => (repository, "版本更新".to_owned()),
    };
    let targets: BTreeSet<_> = items.iter().map(|item| item.1.to_lowercase()).collect();
    // Several versions of one target are a version roundup, not a language or component batch.
    let versions_only = targets.len() == 1 && items.iter().all(|item| !item.2.is_empty());
    let product = if versions_only {
        noun = "版本更新".to_owned();
        let target = &items[0].1;
        if normalized(target).contains(&normalized(&product)) {
            target.clone()
        } else {
            format!("{product} {target}")
        }
    } else {
        product
    };
    let names: Vec<_> = items
        .iter()
        .take(2)
        .map(|(_, target, version)| {
            if versions_only {
                version.clone()
            } else {
                format!("{target} {version}").trim().to_owned()
            }
        })
        .collect();
    let subject = if items.len() > 2 {
        format!("{} 等{}项", names.join(" / "), items.len())
    } else {
        names.join(" / ")
    };
    format!("{product} {noun}：{subject}")
}

pub(super) fn cohorts<'a>(
    candidates: &[&'a Record],
    cutoff: DateTime<Utc>,
) -> Vec<Vec<&'a Record>> {
    let mut ordered = candidates.to_vec();
    ordered.sort_by(|a, b| {
        b.freshness_at
            .cmp(&a.freshness_at)
            .then(a.member.event_id.cmp(&b.member.event_id))
    });
    let mut assigned = HashSet::new();
    let mut result = Vec::new();
    for lead in ordered {
        if assigned.contains(&lead.member.event_id) {
            continue;
        }
        let members = select(lead, candidates, &assigned, cutoff);
        assigned.extend(members.iter().map(|record| record.member.event_id));
        if !members.is_empty() {
            result.push(members);
        }
    }
    result
}

fn select<'a>(
    lead: &'a Record,
    candidates: &[&'a Record],
    assigned: &HashSet<Uuid>,
    cutoff: DateTime<Utc>,
) -> Vec<&'a Record> {
    let Some(release) = &lead.release else {
        return Vec::new();
    };
    let Some(date) = lead.freshness_at.filter(|d| *d <= cutoff) else {
        return Vec::new();
    };
    let mut candidates = candidates.to_vec();
    candidates.sort_by(|a, b| {
        b.freshness_at
            .cmp(&a.freshness_at)
            .then(a.member.event_id.cmp(&b.member.event_id))
    });
    let mut selected = vec![lead];
    let mut targets = HashSet::from([release.target_key.clone()]);
    let (mut earliest, mut latest) = (date, date);
    let mut shared_changes = release.changes.clone();
    for candidate in candidates {
        if assigned.contains(&candidate.member.event_id)
            || candidate.member.event_id == lead.member.event_id
        {
            continue;
        }
        let Some(other) = &candidate.release else {
            continue;
        };
        let Some(other_date) = candidate.freshness_at.filter(|d| *d <= cutoff) else {
            continue;
        };
        let start = earliest.min(other_date);
        let end = latest.max(other_date);
        if other.key != release.key
            || end - start > Duration::hours(WINDOW_HOURS)
            || targets.contains(&other.target_key)
        {
            continue;
        }
        if release.grouping == Grouping::SharedChanges
            && (((release.client || release.package)
                && (shared_changes.is_empty() || other.changes.is_empty()))
                || (!shared_changes.is_empty()
                    && !other.changes.is_empty()
                    && shared_changes.is_disjoint(&other.changes)))
        {
            continue;
        }
        // Keep a common change reference, never connect batch A to batch B through an unqualified entry.
        if release.grouping == Grouping::SharedChanges && !other.changes.is_empty() {
            shared_changes = if shared_changes.is_empty() {
                other.changes.clone()
            } else {
                shared_changes
                    .intersection(&other.changes)
                    .cloned()
                    .collect()
            };
        }
        targets.insert(other.target_key.clone());
        earliest = start;
        latest = end;
        selected.push(candidate);
    }
    selected
}
