use super::*;
use crate::{models::Event, postgres_store::PostgresStore};
use chrono::{Duration, Utc};

pub(super) struct VisualUpgrade {
    sources: Vec<Uuid>,
    events: Vec<Uuid>,
    brief: Uuid,
    protected: Vec<(String, String)>,
    unfinished: Vec<(Uuid, Value)>,
}

async fn protected_migration_data(pool: &PgPool) -> anyhow::Result<Vec<(String, String)>> {
    let mut fingerprints = Vec::new();
    for table in [
        "app_users", "app_settings", "interest_profiles", "user_event_states", "event_exposures",
        "daily_briefs", "daily_brief_items", "reader_shares", "sources", "user_source_overrides",
        "events", "content_items", "reader_personalization", "reader_reading_signals",
    ] {
        let value = if table == "events" { "(to_jsonb(t)-'summary_visual')" } else { "to_jsonb(t)" };
        let fingerprint: String = sqlx::query_scalar(&format!(
            "SELECT md5(COALESCE(string_agg({value}::text,E'\\n' ORDER BY {value}::text),'')) FROM {table} t"
        )).fetch_one(pool).await?;
        fingerprints.push((table.to_owned(), fingerprint));
    }
    Ok(fingerprints)
}

async fn unfinished_job(pool: &PgPool, event: Uuid) -> anyhow::Result<Value> {
    Ok(sqlx::query_scalar(
        "SELECT to_jsonb(j)-'format_version'-'updated_at' FROM summary_jobs j WHERE event_id=$1",
    ).bind(event).fetch_one(pool).await?)
}

pub(super) async fn seed_upgrade(pool: &PgPool) -> anyhow::Result<VisualUpgrade> {
    let mut sources = Vec::new();
    let mut events = Vec::new();
    let now = Utc::now();
    for index in 0..108 {
        let (source, event) = fixture(pool, None, &format!("Visual upgrade {index}")).await?;
        sources.push(source);
        events.push(event);
        let published_at = match index {
            0 => now - Duration::days(6),
            1 => now - Duration::days(5),
            104 => now - Duration::days(8),
            105 => now + Duration::days(1),
            _ => now - Duration::minutes(110 - index),
        };
        sqlx::query("UPDATE content_items SET published_at=$2 WHERE source_id=$1")
            .bind(source).bind(published_at).execute(pool).await?;
        if index >= 106 {
            sqlx::query("UPDATE events SET summary_kind='feed' WHERE id=$1")
                .bind(event).execute(pool).await?;
        }
        let status = match index {
            103 => "failed",
            106 => "pending",
            107 => "running",
            _ => "completed",
        };
        sqlx::query("INSERT INTO summary_jobs(event_id,content_version,format_version,status,attempts,
            last_error,next_attempt_at,lease_id,lease_until)
            VALUES($1,1,3,$2,2,$3,$4,$5,$6) ON CONFLICT(event_id) DO UPDATE SET
            format_version=3,status=EXCLUDED.status,attempts=EXCLUDED.attempts,
            last_error=EXCLUDED.last_error,next_attempt_at=EXCLUDED.next_attempt_at,
            lease_id=EXCLUDED.lease_id,lease_until=EXCLUDED.lease_until")
            .bind(event).bind(status).bind((index == 103).then_some("fixture failure"))
            .bind((index == 106).then_some(now + Duration::minutes(2)))
            .bind((index == 107).then(Uuid::new_v4))
            .bind((index == 107).then_some(now + Duration::minutes(5)))
            .execute(pool).await?;
    }
    let brief = Uuid::new_v4();
    sqlx::query("INSERT INTO daily_briefs(id,local_date,status,generated_at,published_at,rule_version,
        window_start,window_end,sections,owner_user_id)
        VALUES($1,$2,'published',$3,$3,'editorial-significance-v1-ranked-v2',$4,$3,'[]',$5)")
        .bind(brief).bind(crate::reader::local_date(now)).bind(now)
        .bind(now-Duration::days(7)).bind(Uuid::new_v4().to_string()).execute(pool).await?;
    sqlx::query("INSERT INTO daily_brief_items(brief_id,event_id,rank,section,selection_reason,snapshot)
        VALUES($1,$2,1,'fixture','fixture',$3)")
        .bind(brief).bind(events[0]).bind(json!({"id":events[0],"summary":"retained snapshot"}))
        .execute(pool).await?;
    let mut unfinished = Vec::new();
    for index in [103,106,107] {
        unfinished.push((events[index],unfinished_job(pool,events[index]).await?));
    }
    Ok(VisualUpgrade { sources, events, brief, protected:protected_migration_data(pool).await?, unfinished })
}

impl VisualUpgrade {
    pub(super) async fn verify_and_cleanup(mut self, pool: &PgPool) -> anyhow::Result<()> {
        assert_eq!(protected_migration_data(pool).await?,self.protected,
            "visual migration must retain summary text, edition snapshots, sources and reader data");
        assert_eq!(sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM summary_jobs WHERE event_id=ANY($1) AND format_version=4 AND status='pending'",
        ).bind(&self.events[..103]).fetch_one(pool).await?,100,"recent upgrades are capped at 100");
        let selected: (i32,String) = sqlx::query_as(
            "SELECT format_version,status FROM summary_jobs WHERE event_id=$1",
        ).bind(self.events[0]).fetch_one(pool).await?;
        assert_eq!(selected,(4,"pending".to_owned()),"current selected article precedes newer unselected articles");
        for index in [1,104,105] {
            let job: (i32,String) = sqlx::query_as(
                "SELECT format_version,status FROM summary_jobs WHERE event_id=$1",
            ).bind(self.events[index]).fetch_one(pool).await?;
            assert_eq!(job,(3,"completed".to_owned()),"over-cap, old and future summaries are not queued");
        }
        for (event,before) in self.unfinished {
            assert_eq!(unfinished_job(pool,event).await?,before,"migration must not resume failures or alter leases");
            assert_eq!(sqlx::query_scalar::<_, i32>(
                "SELECT format_version FROM summary_jobs WHERE event_id=$1",
            ).bind(event).fetch_one(pool).await?,4);
        }
        assert_eq!(sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM events WHERE id=ANY($1) AND summary_visual IS NOT NULL",
        ).bind(&self.events).fetch_one(pool).await?,0,"migration does not fabricate diagrams");
        let (source,event) = fixture(pool,None,"Visual upgrade new trigger").await?;
        self.sources.push(source);
        self.events.push(event);
        let new_job: (i32,String) = sqlx::query_as(
            "SELECT format_version,status FROM summary_jobs WHERE event_id=$1",
        ).bind(event).fetch_one(pool).await?;
        assert_eq!(new_job,(4,"pending".to_owned()));
        sqlx::query("DELETE FROM daily_briefs WHERE id=$1").bind(self.brief).execute(pool).await?;
        sqlx::query("DELETE FROM events WHERE id=ANY($1)").bind(&self.events).execute(pool).await?;
        sqlx::query("DELETE FROM content_items WHERE source_id=ANY($1)").bind(&self.sources).execute(pool).await?;
        sqlx::query("DELETE FROM sources WHERE id=ANY($1)").bind(&self.sources).execute(pool).await?;
        Ok(())
    }
}

pub(super) async fn verify(pool: &PgPool, app: &Router) -> anyhow::Result<()> {
    let reader = Reader::new(app, principal(Uuid::new_v4(), Uuid::new_v4(), "Visual contract")).await;
    let db = ScopedDb::from(pool.clone()).reader(&reader.id.to_string());
    let store = PostgresStore::new(db.clone());
    let (primary_source, primary) = fixture(pool, None, "Visual primary").await?;
    let (secondary_source, secondary) = fixture(pool, None, "Visual T2").await?;
    sqlx::query("UPDATE sources SET tier='T2' WHERE id=$1")
        .bind(secondary_source).execute(pool).await?;
    for (id, expected) in [(primary, true), (secondary, false)] {
        assert_eq!(
            sqlx::query_scalar::<_, bool>("SELECT reader_daily_source_eligible($1)")
                .bind(id).fetch_one(&db).await?,
            expected,
        );
    }
    let radar = reader.ok("GET", &format!("/api/v1/events/{secondary}"), Value::Null).await;
    assert_eq!(radar["evidence"][0]["sourceTier"], "T2", "source is still readable");
    let today = crate::reader::local_date(Utc::now());
    let draft = store.brief(today, false).await?.expect("daily draft");
    assert!(draft.items.iter().all(crate::reader::daily_source_qualified));
    assert!(!draft.items.iter().any(|event| event.id == secondary));

    let secondary_content: Uuid = sqlx::query_scalar(
        "SELECT content_item_id FROM event_evidence WHERE event_id=$1",
    ).bind(secondary).fetch_one(pool).await?;
    sqlx::query("INSERT INTO event_evidence(event_id,content_item_id,is_official) VALUES($1,$2,false)")
        .bind(primary).bind(secondary_content).execute(pool).await?;
    assert!(!sqlx::query_scalar::<_, bool>("SELECT reader_daily_source_eligible($1)")
        .bind(primary).fetch_one(&db).await?, "mixed direct evidence cannot bypass the tier gate");
    sqlx::query("DELETE FROM event_evidence WHERE event_id=$1 AND content_item_id=$2")
        .bind(primary).bind(secondary_content).execute(pool).await?;
    sqlx::query("UPDATE sources SET tier='T1.5' WHERE id=$1")
        .bind(primary_source).execute(pool).await?;
    assert!(sqlx::query_scalar::<_, bool>("SELECT reader_daily_source_eligible($1)")
        .bind(primary).fetch_one(&db).await?);

    let event = store.get_event(primary).await?.expect("source event");
    let output = json!({
        "points":["据报告说明，方案甲使用公开数据，不读取私人数据。",
            "据报告说明，方案乙需要人工确认，结果并非自动可靠。"],
        "materialLimit":null,"limitations":[],"importance":"",
        "evidenceIds":[event.evidence[0].id],
        "visual":{"version":1,"kind":"comparison","items":[
            {"label":"方案甲","detail":"方案甲使用公开数据，不读取私人数据","point":1},
            {"label":"方案乙","detail":"方案乙需要人工确认，结果并非自动可靠","point":2}
        ]}
    }).to_string();
    let generated = crate::summary::parse_output(&output, &event)?;
    let expected = serde_json::to_value(&generated.visual)?;
    let writer = PostgresStore::new(pool.clone());
    let saved = writer.save_summary(primary, generated, "gpt-5.6-terra", event.content_version, Some("low"))
        .await?.expect("saved generated summary");
    assert_eq!(saved.summary_format_version, 4);
    assert_eq!(serde_json::to_value(&saved.summary_visual)?, expected);
    assert_eq!(saved.summary_status.as_deref(), Some("completed"));
    let detail = reader.ok("GET", &format!("/api/v1/events/{primary}"), Value::Null).await;
    assert_eq!(detail["summaryVisual"], expected);
    assert_eq!(detail["summaryPoints"], serde_json::to_value(&saved.summary_points)?);
    let roundtrip: Event = serde_json::from_value(serde_json::to_value(&saved)?)?;
    assert_eq!(serde_json::to_value(roundtrip.summary_visual)?, expected, "snapshots retain the exact diagram");
    for (points, visual) in [
        (json!(["系统先检索材料，再生成回答；此顺序不代表效果提升。",
            "检索材料仅使用公开文档。","生成回答须保留来源。"]),
         json!({"version":2,"kind":"flow","items":[
            {"label":"检索材料","detail":"检索材料仅使用公开文档","point":2},
            {"label":"生成回答","detail":"生成回答须保留来源","point":3}
         ],"basis":{"point":1,"quote":"系统先检索材料，再生成回答；此顺序不代表效果提升。"}})),
        (json!(["2026-10-01发布方公布预览。","2026-10-15发布方更新使用说明。"]),
         json!({"version":2,"kind":"timeline","items":[
            {"label":"2026-10-01","detail":"2026-10-01发布方公布预览","point":1},
            {"label":"2026-10-15","detail":"2026-10-15发布方更新使用说明","point":2}
         ]})),
    ] {
        let generated = crate::summary::parse_output(&json!({"points":points,
            "materialLimit":null,"limitations":[],"importance":"",
            "evidenceIds":[event.evidence[0].id],"visual":visual}).to_string(), &event)?;
        let saved = writer.save_summary(primary, generated, "gpt-5.6-terra", event.content_version, Some("low"))
            .await?.expect("saved version 2 visual");
        assert_eq!(saved.summary_format_version, 4, "visual version does not reset summary jobs");
        let detail = reader.ok("GET", &format!("/api/v1/events/{primary}"), Value::Null).await;
        assert_eq!(detail["summaryVisual"], visual, "API must retain version 2 and sequence evidence");
        let snapshot: Event = serde_json::from_value(serde_json::to_value(saved)?)?;
        assert_eq!(serde_json::to_value(snapshot.summary_visual)?, visual);
    }
    let before_stale: Value = sqlx::query_scalar("SELECT to_jsonb(e) FROM events e WHERE id=$1")
        .bind(primary).fetch_one(pool).await?;
    assert!(writer.save_summary(primary,crate::summary::parse_output(&output,&event)?,
        "gpt-5.6-terra",event.content_version+1,Some("low")).await?.is_none());
    assert_eq!(sqlx::query_scalar::<_, Value>("SELECT to_jsonb(e) FROM events e WHERE id=$1")
        .bind(primary).fetch_one(pool).await?,before_stale,"stale generation must not write text or visual");

    // The helper is SECURITY INVOKER and must not expose another reader's private evidence.
    let other = Reader::new(app, principal(Uuid::new_v4(), Uuid::new_v4(), "Private visual")).await;
    let (_, private) = fixture(pool, Some(other.id.to_string()), "Private visual source").await?;
    assert!(!sqlx::query_scalar::<_, bool>("SELECT reader_daily_source_eligible($1)")
        .bind(private).fetch_one(&db).await?);
    assert!(sqlx::query_scalar::<_, bool>("SELECT reader_daily_source_eligible($1)")
        .bind(private).fetch_one(&ScopedDb::from(pool.clone()).reader(&other.id.to_string())).await?);

    // A source-policy upgrade must also remove a saved T2-only edition when no
    // replacement qualifies; the ordinary empty-candidate fallback cannot keep it.
    let cutoff = "2001-01-02T02:00:00Z".parse::<chrono::DateTime<Utc>>()?;
    sqlx::query("UPDATE content_items SET published_at=$2 WHERE id=$1")
        .bind(secondary_content).bind(cutoff-Duration::hours(1)).execute(pool).await?;
    let snapshot = writer.get_event(secondary).await?.expect("T2 snapshot");
    let current_id = Uuid::new_v4();
    let past_id = Uuid::new_v4();
    for (brief, date) in [(current_id,today),(past_id,today.pred_opt().unwrap())] {
        sqlx::query("INSERT INTO daily_briefs(id,local_date,status,generated_at,published_at,rule_version,
            window_start,window_end,sections,owner_user_id)
            VALUES($1,$2,'published',now(),now(),'editorial-significance-v1-ranked-v2',$3,$4,'[]',$5)")
            .bind(brief).bind(date).bind(cutoff-Duration::days(7)).bind(cutoff)
            .bind(reader.id.to_string()).execute(pool).await?;
        sqlx::query("INSERT INTO daily_brief_items(brief_id,event_id,rank,section,selection_reason,snapshot)
            VALUES($1,$2,1,'fixture','fixture',$3)")
            .bind(brief).bind(secondary).bind(serde_json::to_value(&snapshot)?).execute(pool).await?;
    }
    assert!(store.reselect_outdated_brief(today).await?);
    assert!(store.brief(today,false).await?.expect("empty saved edition").items.is_empty());
    assert!(!store.reselect_outdated_brief(today).await?);
    let historical = store.brief(today.pred_opt().unwrap(),false).await?.expect("historical edition");
    assert_eq!(historical.items.len(),1);
    assert_eq!(historical.items[0].id,secondary,"past editions are not rewritten");
    let audit: Value = sqlx::query_scalar(
        "SELECT before_value FROM admin_audits WHERE action='edition_reselect' AND target_id=$1",
    ).bind(current_id.to_string()).fetch_one(&db).await?;
    assert_eq!(audit["items"][0]["eventId"],secondary.to_string());
    Ok(())
}
