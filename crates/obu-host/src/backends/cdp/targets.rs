//! CDP target operations.

use std::collections::HashMap;

use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::backends::{BackendRequestContext, cdp::CdpBackend};
use crate::error::{HostError, Result};
use crate::tab_state::{TabId, TabOrigin, TabRecord, TabStatus};

struct ObservedTarget {
    target_id: String,
    url: String,
    title: String,
    attached: bool,
}

/// Create a new page target and register it as an agent-owned session tab.
pub async fn create_tab(
    backend: &CdpBackend,
    url: Option<String>,
    session_id: &str,
) -> Result<Value> {
    let url = url.unwrap_or_else(|| "about:blank".into());
    let result = backend
        .transport()
        .send_command("Target.createTarget", json!({ "url": url }), None)
        .await
        .map_err(HostError::from)?;
    let target_id = result
        .get("targetId")
        .and_then(Value::as_str)
        .ok_or_else(|| HostError::Protocol("Target.createTarget missing targetId".into()))?
        .to_string();

    let tab_id = TabId::new(format!("tab-{}", Uuid::new_v4()));
    let record = TabRecord {
        id: tab_id.clone(),
        session_id: Some(session_id.to_string()),
        target_id: target_id.clone(),
        url: url.clone(),
        title: String::new(),
        origin: TabOrigin::Agent,
        status: TabStatus::Active,
        attached: false,
        cdp_session_id: None,
    };
    backend.registry().insert(record)?;
    let tab_id_value = tab_id.0.clone();

    Ok(json!({
        "id": tab_id_value,
        "tab_id": tab_id_value,
        "target_id": target_id,
        "url": url,
        "title": "",
    }))
}

/// List page targets without mutating host registry lifecycle state.
pub async fn list_tabs(backend: &CdpBackend) -> Result<Value> {
    let existing_by_target: HashMap<String, TabRecord> = backend
        .registry()
        .list()?
        .into_iter()
        .map(|record| (record.target_id.clone(), record))
        .collect();

    let mut out = Vec::new();
    for target in observed_page_targets(backend).await? {
        let record = observed_target_record(existing_by_target.get(&target.target_id), &target);
        out.push(tab_record_to_value(&record));
    }
    Ok(Value::Array(out))
}

/// Return the host-owned logical current tab for a session.
pub async fn current_tab(backend: &CdpBackend, ctx: &BackendRequestContext) -> Result<Value> {
    let session_id = require_session_id(ctx, "getCurrentTab")?;
    Ok(backend
        .registry()
        .current_tab_for_session(session_id)?
        .map(|record| tab_record_to_value_with_logical_active(&record, true))
        .unwrap_or(Value::Null))
}

/// CDP cannot reliably observe a browser-visible selected tab, so expose only the
/// session-owned logical current tab through this discovery path.
pub async fn selected_tab(backend: &CdpBackend, ctx: &BackendRequestContext) -> Result<Value> {
    current_tab(backend, ctx).await
}

/// Close a tab and remove host-side state for it.
pub async fn close_tab(backend: &CdpBackend, tab_id: &str) -> Result<Value> {
    let id = TabId::new(tab_id);
    let record = crate::backends::cdp::attach::require_active_record(backend, tab_id)?;
    if !record.attached || record.cdp_session_id.is_none() {
        crate::backends::cdp::attach::attach(backend, tab_id).await?;
    }
    let session_id = crate::backends::cdp::attach::require_session(backend, tab_id)?;

    let operation = async {
        backend
            .transport()
            .send_command("Page.close", json!({}), Some(&session_id))
            .await
            .map_err(HostError::from)
    };
    let context =
        crate::backends::cdp::dialogs::context_for_tab(backend, tab_id, &session_id, "tab_close");
    crate::backends::cdp::dialogs::run_with_dialog_policy(backend, context, operation).await?;
    backend.registry().clear_playwright_injected(&id)?;
    let _ = backend.registry().remove(&id)?;
    Ok(Value::Null)
}

/// Claim an existing CDP tab for the current host session.
pub async fn claim_user_tab(
    backend: &CdpBackend,
    ctx: &BackendRequestContext,
    tab_id: &str,
) -> Result<Value> {
    let session_id = require_session_id(ctx, "claimUserTab")?;
    backend
        .registry()
        .touch_session(session_id, ctx.turn_id.as_deref())?;
    let id = TabId::new(tab_id);
    if backend.registry().get(&id)?.is_none() {
        reconcile_tabs(backend).await?;
    }
    let Some(mut record) = backend.registry().get(&id)? else {
        return Err(HostError::PageClosed(format!("unknown tab {tab_id}")));
    };
    if let Some(owner) = record.session_id.as_deref()
        && record.status != TabStatus::Deliverable
        && owner != session_id
    {
        return Err(HostError::Protocol(format!(
            "tab {tab_id} is already owned by another open-browser-use session"
        )));
    }
    record.session_id = Some(session_id.to_string());
    record.origin = TabOrigin::User;
    record.status = TabStatus::Active;
    backend.registry().insert(record.clone())?;
    backend
        .registry()
        .set_active_tab(session_id, record.id.clone(), ctx.turn_id.as_deref())?;
    Ok(tab_record_to_value(&record))
}

/// Explicitly import currently observed CDP page targets into the host registry.
async fn reconcile_tabs(backend: &CdpBackend) -> Result<()> {
    let existing_by_target: HashMap<String, TabRecord> = backend
        .registry()
        .list()?
        .into_iter()
        .map(|record| (record.target_id.clone(), record))
        .collect();
    for target in observed_page_targets(backend).await? {
        upsert_target_record(
            backend,
            existing_by_target.get(&target.target_id).cloned(),
            &target.target_id,
            &target.url,
            &target.title,
            target.attached,
        )?;
    }
    Ok(())
}

/// Finalize CDP session tabs using host-owned lifecycle state.
pub async fn finalize_tabs(
    backend: &CdpBackend,
    ctx: &BackendRequestContext,
    params: Value,
) -> Result<Value> {
    let session_id = require_session_id(ctx, "finalizeTabs")?;
    backend
        .registry()
        .assert_agent_owns_session(session_id, "finalizeTabs")?;
    backend
        .registry()
        .touch_session(session_id, ctx.turn_id.as_deref())?;
    let keep = parse_finalize_keep(&params)?;
    let session_tabs = backend.registry().tabs_for_session(session_id)?;
    let mut closed_tab_ids = Vec::new();
    let mut released_tab_ids = Vec::new();
    let mut kept_tabs = Vec::new();
    let mut deliverable_tabs = Vec::new();

    for record in session_tabs {
        match keep.get(&record.id.0) {
            Some(TabStatus::Handoff) => {
                if record.attached {
                    crate::backends::cdp::attach::detach(backend, &record.id.0).await?;
                } else {
                    backend.registry().clear_tab_handles(&record.id)?;
                }
                backend.registry().update(&record.id, |record| {
                    record.status = TabStatus::Handoff;
                    record.attached = false;
                    record.cdp_session_id = None;
                })?;
                if let Some(record) = backend.registry().get(&record.id)? {
                    kept_tabs.push(tab_record_to_value(&record));
                }
            }
            Some(TabStatus::Deliverable) => {
                if record.attached {
                    crate::backends::cdp::attach::detach(backend, &record.id.0).await?;
                } else {
                    backend.registry().clear_tab_handles(&record.id)?;
                }
                backend.registry().update(&record.id, |record| {
                    record.status = TabStatus::Deliverable;
                    record.attached = false;
                    record.cdp_session_id = None;
                })?;
                if let Some(record) = backend.registry().get(&record.id)? {
                    let value = tab_record_to_value(&record);
                    kept_tabs.push(value.clone());
                    deliverable_tabs.push(value);
                }
            }
            Some(TabStatus::Active) => {
                return Err(HostError::Protocol(
                    "finalizeTabs keep status must be handoff or deliverable".into(),
                ));
            }
            None => match record.origin {
                TabOrigin::Agent => {
                    close_tab(backend, &record.id.0).await?;
                    closed_tab_ids.push(Value::String(record.id.0));
                }
                TabOrigin::User => {
                    if record.attached {
                        crate::backends::cdp::attach::detach(backend, &record.id.0).await?;
                    } else {
                        backend.registry().clear_tab_handles(&record.id)?;
                    }
                    let _ = backend
                        .registry()
                        .remove_with_reason(&record.id, "CDP finalizeTabs released user tab")?;
                    released_tab_ids.push(Value::String(record.id.0));
                }
            },
        }
    }
    let _ = backend.registry().repair_current_tab_for_session(session_id)?;

    Ok(json!({
        "closed_tab_ids": closed_tab_ids,
        "released_tab_ids": released_tab_ids,
        "kept_tabs": kept_tabs,
        "deliverable_tabs": deliverable_tabs,
    }))
}

fn upsert_target_record(
    backend: &CdpBackend,
    existing: Option<TabRecord>,
    target_id: &str,
    url: &str,
    title: &str,
    attached: bool,
) -> Result<TabRecord> {
    if let Some(mut record) = existing {
        record.url = url.to_string();
        record.title = title.to_string();
        record.attached = attached;
        backend.registry().insert(record.clone())?;
        return Ok(record);
    }

    let id = TabId::new(target_id.to_string());
    let record = TabRecord {
        id: id.clone(),
        session_id: None,
        target_id: target_id.to_string(),
        url: url.to_string(),
        title: title.to_string(),
        origin: TabOrigin::User,
        status: TabStatus::Active,
        attached,
        cdp_session_id: None,
    };
    backend.registry().insert(record.clone())?;
    Ok(record)
}

async fn observed_page_targets(backend: &CdpBackend) -> Result<Vec<ObservedTarget>> {
    let result = backend
        .transport()
        .send_command("Target.getTargets", Value::Object(Map::new()), None)
        .await
        .map_err(HostError::from)?;
    let targets = result
        .get("targetInfos")
        .and_then(Value::as_array)
        .ok_or_else(|| HostError::Protocol("Target.getTargets missing targetInfos".into()))?;

    let mut observed = Vec::new();
    for target in targets {
        if target.get("type").and_then(Value::as_str) != Some("page") {
            continue;
        }
        let Some(target_id) = target.get("targetId").and_then(Value::as_str) else {
            continue;
        };
        observed.push(ObservedTarget {
            target_id: target_id.to_string(),
            url: target
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            title: target
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            attached: target
                .get("attached")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
    Ok(observed)
}

fn observed_target_record(existing: Option<&TabRecord>, target: &ObservedTarget) -> TabRecord {
    if let Some(record) = existing {
        let mut observed = record.clone();
        observed.url = target.url.clone();
        observed.title = target.title.clone();
        observed.attached = target.attached;
        return observed;
    }

    TabRecord {
        id: TabId::new(target.target_id.clone()),
        session_id: None,
        target_id: target.target_id.clone(),
        url: target.url.clone(),
        title: target.title.clone(),
        origin: TabOrigin::User,
        status: TabStatus::Active,
        attached: target.attached,
        cdp_session_id: None,
    }
}

fn require_session_id<'a>(ctx: &'a BackendRequestContext, method: &str) -> Result<&'a str> {
    let session_id = ctx.session_id.as_deref().unwrap_or_default();
    if session_id.is_empty() {
        return Err(HostError::Protocol(format!(
            "{method} requires session_id for CDP lifecycle"
        )));
    }
    Ok(session_id)
}

fn parse_finalize_keep(params: &Value) -> Result<HashMap<String, TabStatus>> {
    let rows = params
        .get("keep")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut keep = HashMap::new();
    for row in rows {
        let object = row.as_object().ok_or_else(|| {
            HostError::Protocol("finalizeTabs keep entries must be objects".into())
        })?;
        let tab_id = object
            .get("tab_id")
            .or_else(|| object.get("tabId"))
            .or_else(|| object.get("id"))
            .and_then(|value| match value {
                Value::String(value) => Some(value.clone()),
                Value::Number(value) => value.as_i64().map(|value| value.to_string()),
                _ => None,
            })
            .ok_or_else(|| HostError::Protocol("finalizeTabs keep entry missing tab id".into()))?;
        let status = match object.get("status").and_then(Value::as_str) {
            Some("handoff") => TabStatus::Handoff,
            Some("deliverable") => TabStatus::Deliverable,
            _ => {
                return Err(HostError::Protocol(
                    "finalizeTabs keep status must be handoff or deliverable".into(),
                ));
            }
        };
        if keep.insert(tab_id.clone(), status).is_some() {
            return Err(HostError::Protocol(format!(
                "finalizeTabs keep contains duplicate tab {tab_id}"
            )));
        }
    }
    Ok(keep)
}

fn tab_record_to_value(record: &TabRecord) -> Value {
    tab_record_to_value_with_logical_active(record, false)
}

fn tab_record_to_value_with_logical_active(record: &TabRecord, logical_active: bool) -> Value {
    json!({
        "id": record.id.0.clone(),
        "tab_id": record.id.0.clone(),
        "target_id": record.target_id.clone(),
        "url": record.url.clone(),
        "title": record.title.clone(),
        "origin": match record.origin {
            TabOrigin::Agent => "agent",
            TabOrigin::User => "user",
        },
        "status": match record.status {
            TabStatus::Active => "active",
            TabStatus::Handoff => "handoff",
            TabStatus::Deliverable => "deliverable",
        },
        "attached": record.attached,
        "owned": record.session_id.is_some(),
        "claimRequired": record.session_id.is_none(),
        "commandable": record.session_id.is_some() && record.status == TabStatus::Active,
        "logicalActive": logical_active,
    })
}
