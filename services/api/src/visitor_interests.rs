use std::{collections::HashSet, sync::OnceLock};

use serde::Deserialize;

use crate::models::Topic;

#[derive(Debug, Deserialize)]
struct InterestOption {
    id: String,
    label: String,
}

fn catalog() -> &'static [InterestOption] {
    static CATALOG: OnceLock<Vec<InterestOption>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../shared/reader-interest-topics.json"))
            .expect("checked-in visitor interest catalog must be valid")
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(try_from = "String")]
pub struct VisitorInterests {
    topics: Vec<Topic>,
}

impl VisitorInterests {
    pub fn topics(&self) -> &[Topic] {
        &self.topics
    }

    pub fn as_json(&self) -> serde_json::Value {
        serde_json::json!(self.topics)
    }
}

impl TryFrom<String> for VisitorInterests {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let invalid = || "兴趣主题参数无效，请使用已提供的主题和 0–100 的整数权重。".to_owned();
        if value.is_empty() || value.len() > 512 {
            return Err(invalid());
        }
        let mut ids = HashSet::new();
        let mut topics = Vec::new();
        for item in value.split(',') {
            let (id, raw_weight) = item.split_once(':').ok_or_else(invalid)?;
            let option = catalog().iter().find(|option| option.id == id).ok_or_else(invalid)?;
            let weight = raw_weight.parse::<i32>().map_err(|_| invalid())?;
            if !(0..=100).contains(&weight) || raw_weight != weight.to_string()
                || !ids.insert(id.to_owned()) || topics.len() >= catalog().len()
            {
                return Err(invalid());
            }
            topics.push(Topic {
                id: option.id.clone(),
                label: option.label.clone(),
                group: "访客兴趣".into(),
                weight,
                context: "long_term".into(),
                enabled: true,
            });
        }
        topics.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(Self { topics })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visitor_interests_are_bounded_canonical_and_not_owner_topics() {
        let profile = VisitorInterests::try_from("psychology:100,agents:50".to_owned()).unwrap();
        assert_eq!(profile.topics()[0].label, "Agent 与工具");
        assert_eq!(profile.topics()[1].label, "心理与认知");
        assert!(profile.topics().iter().all(|topic| topic.enabled));
        for input in ["", "local:100", "agents:101", "agents:-1", "agents:1.5",
            "agents:050", "agents:50,agents:100", "agents:50,", "agents:50:1",
            "psychology%3A100", "agents:50&saved=true"]
        {
            assert!(VisitorInterests::try_from(input.to_owned()).is_err(), "{input}");
        }
        assert!(VisitorInterests::try_from("x".repeat(513)).is_err());
    }

    #[test]
    fn visitor_interest_catalog_matches_existing_editorial_facets() {
        let policy = include_str!("../migrations/0022_editorial_article_policy.sql");
        let mut ids = HashSet::new();
        let mut labels = HashSet::new();
        for option in catalog() {
            assert!(ids.insert(&option.id));
            assert!(labels.insert(&option.label));
            assert!(policy.contains(&format!("'{}'", option.label)));
            assert!(VisitorInterests::try_from(format!("{}:80", option.id)).is_ok());
        }
        assert_eq!(catalog().len(), 13);
    }
}
