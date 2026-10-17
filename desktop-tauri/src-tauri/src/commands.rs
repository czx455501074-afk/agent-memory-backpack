use crate::core_client::{BridgeResponse, CoreClient};
use serde_json::{json, Value};

type Reply = Result<BridgeResponse<Value>, String>;

async fn call(path: &str, body: Value, admin: bool) -> Reply {
    let client = match CoreClient::from_config() {
        Ok(client) => client,
        Err(_) => return Ok(BridgeResponse::failure("configuration", "Credential configuration is unavailable or invalid")),
    };
    if admin && !client.is_admin() {
        return Ok(BridgeResponse::failure("forbidden", "This operation requires an admin credential"));
    }
    Ok(client.post(path, body).await)
}

#[tauri::command]
pub async fn view(kind: String, args: Option<Value>) -> Reply {
    let args = args.unwrap_or_else(|| json!({}));
    let (path, body, admin) = match kind.as_str() {
        "status" => ("/v1/stats", json!({}), false),
        "norms" => ("/v1/norms", json!({}), false),
        "proposals" => ("/v1/proposals/list", json!({"state": args.get("state").and_then(Value::as_str).unwrap_or("pending")}), true),
        "proposal" => ("/v1/proposals/get", json!({"id": args.get("id")}), true),
        "workflows" => ("/v1/search", json!({"query": args.get("query").and_then(Value::as_str).unwrap_or("")}), false),
        "tasks" => ("/v1/tasks/list", json!({}), false),
        "unstructured" => ("/v1/knowledge/unstructured", json!({}), false),
        "knowledge" => ("/v1/knowledge/read", json!({"knowledgeId": args.get("knowledgeId"), "includeLeaves": args.get("includeLeaves").and_then(Value::as_bool).unwrap_or(false)}), false),
        "knowledgeEntry" => ("/v1/knowledge/get", json!({"id": args.get("id")}), false),
        "knowledgeSearch" => ("/v1/knowledge/search-universal", json!({"query": args.get("query").and_then(Value::as_str).unwrap_or(""), "literal": true, "limit": 100}), false),
        "history" => ("/v1/knowledge/history", json!({"knowledgeId": args.get("knowledgeId")}), false),
        "rescanState" => ("/v1/rescan/state", json!({}), false),
        "workflowDrafts" => ("/v1/workflow-drafts/list", json!({}), true),
        "maintenance" => ("/v1/maintenance/status", json!({}), true),
        _ => return Ok(BridgeResponse::failure("unknown_view", "Unsupported view")),
    };
    call(path, body, admin).await
}

#[tauri::command]
pub async fn target() -> Reply {
    match CoreClient::from_config() {
        Ok(client) => Ok(BridgeResponse::success(client.target())),
        Err(_) => Ok(BridgeResponse::failure("configuration", "Credential configuration is unavailable or invalid")),
    }
}

/// Address of the core's own console, credential fragment included.
///
/// Separate from `target` on purpose: `target` is a read-only description of where the core is,
/// and it is surfaced in the UI. The console address carries a credential, so it is a distinct
/// call that the shell makes only when it is about to navigate the webview.
#[tauri::command]
pub async fn console_url() -> Reply {
    match CoreClient::from_config() {
        Ok(client) => Ok(BridgeResponse::success(json!({ "url": client.console_url() }))),
        Err(_) => Ok(BridgeResponse::failure("configuration", "Credential configuration is unavailable or invalid")),
    }
}

#[tauri::command]
pub async fn doctor() -> Reply {
    // A connectivity probe is not the existing Node doctor's full filesystem audit.
    let result = call("/v1/stats", json!({}), false).await?;
    if !result.ok { return Ok(result); }
    Ok(BridgeResponse::success(json!({
        "ok": true, "coverage": "core_connectivity_only",
        "checks": [{"title": "Core connectivity and credential", "status": "pass",
            "detail": "Authenticated statistics request succeeded"},
            {"title": "Filesystem and installation audit", "status": "skip",
            "detail": "Full native doctor is not implemented"}]
    })))
}

// Native dialogs and inspected-file state must be supplied by the shell owner.
// Never accept a renderer path while that boundary is missing.
fn migration_pending() -> Reply {
    Ok(BridgeResponse::failure("not_implemented", "Native migration dialogs and file-state validation are not implemented"))
}

#[tauri::command]
pub async fn backup_export() -> Reply { migration_pending() }
#[tauri::command]
pub async fn backup_inspect() -> Reply { migration_pending() }
#[tauri::command]
pub async fn backup_import() -> Reply { migration_pending() }
#[tauri::command]
pub async fn reveal_export() -> Reply { migration_pending() }

#[tauri::command]
pub async fn approve_proposal(id: String, entry: Value, allow_global_scope: Option<bool>) -> Reply {
    call("/v1/proposals/approve", json!({"id": id, "entry": entry,
        "allowGlobalScope": allow_global_scope.unwrap_or(false)}), true).await
}

#[tauri::command]
pub async fn reject_proposal(id: String, reason: Option<String>) -> Reply {
    let mut body = json!({"id": id});
    if let Some(reason) = reason { body["reason"] = json!(reason); }
    call("/v1/proposals/reject", body, true).await
}

#[tauri::command]
pub async fn archive_proposal(id: String) -> Reply {
    call("/v1/proposals/archive", json!({"id": id}), true).await
}

#[tauri::command]
pub async fn write_knowledge(entry: Value) -> Reply {
    if !entry.get("baseRevision").and_then(Value::as_u64)
        .map(|revision| revision <= 9_007_199_254_740_991).unwrap_or(false) {
        return Ok(BridgeResponse::failure("invalid_request", "An explicit nonnegative safe baseRevision is required"));
    }
    call("/v1/knowledge/write", json!({"entry": entry}), true).await
}

#[tauri::command]
pub async fn delete_knowledge(id: String, base_revision: u64) -> Reply {
    if base_revision > 9_007_199_254_740_991 {
        return Ok(BridgeResponse::failure("invalid_request", "Invalid baseRevision"));
    }
    call("/v1/knowledge/delete", json!({"id": id, "baseRevision": base_revision}), true).await
}

#[tauri::command]
pub async fn supersede_knowledge(old_id: String, new_id: String, action: Option<String>, reason: String, evidence: String) -> Reply {
    call("/v1/knowledge/supersede", json!({"oldId": old_id, "newId": new_id,
        "action": action.unwrap_or_else(|| "supersede".into()), "reason": reason, "evidence": evidence}), true).await
}

#[tauri::command]
pub async fn approve_workflow_draft(id: String) -> Reply {
    call("/v1/workflow-drafts/approve", json!({"id": id}), true).await
}

#[tauri::command]
pub async fn retry_maintenance(id: String) -> Reply {
    call("/v1/maintenance/retry", json!({"id": id}), true).await
}

// -------------------------------------------------------------- shell state

/// Reads the real login-item state from the OS (Windows Run key, macOS login
/// item, XDG autostart file). Never a cached or requested value.
#[tauri::command]
pub async fn auto_launch_status() -> Reply {
    match crate::auto_launch::is_auto_launch_enabled() {
        Ok(enabled) => Ok(BridgeResponse::success(json!({ "enabled": enabled }))),
        Err(error) => Ok(BridgeResponse::failure("auto_launch_unavailable", &error)),
    }
}

/// Enables or disables the login item and reports what the OS actually holds
/// afterwards, so a silent platform failure cannot be mistaken for success.
#[tauri::command]
pub async fn set_auto_launch(enabled: bool) -> Reply {
    let changed = if enabled {
        crate::auto_launch::enable_auto_launch()
    } else {
        crate::auto_launch::disable_auto_launch()
    };

    if let Err(error) = changed {
        return Ok(BridgeResponse::failure("auto_launch_failed", &error));
    }

    auto_launch_status().await
}

/// Every endpoint the status panel needs, in one round trip.
///
/// Routes and field names come from `src/server.ts`: `/v1/stats` returns
/// `knowledgeRevision`, `entries`, `pendingProposals`, `tasks`, `outbox`,
/// `lastRescanAt`; `/v1/proposals/list` returns `proposals`; `/v1/tasks/list`
/// returns `tasks`. No endpoint or field is invented here.
#[tauri::command]
pub async fn core_overview() -> Reply {
    let client = match CoreClient::from_config() {
        Ok(client) => client,
        Err(_) => {
            return Ok(BridgeResponse::failure(
                "configuration",
                "Credential configuration is unavailable or invalid",
            ))
        }
    };

    let stats = client.post("/v1/stats", json!({})).await;
    let rescan = client.post("/v1/rescan/state", json!({})).await;
    let tasks = client.post("/v1/tasks/list", json!({})).await;
    let proposals = if client.is_admin() {
        client
            .post("/v1/proposals/list", json!({"state": "pending"}))
            .await
    } else {
        BridgeResponse::failure("forbidden", "This operation requires an admin credential")
    };

    // Each entry keeps the core's own envelope, so a partially reachable core is
    // reported per view instead of collapsing into one failed call.
    Ok(BridgeResponse::success(json!({
        "target": client.target(),
        "stats": stats,
        "rescan": rescan,
        "tasks": tasks,
        "proposals": proposals,
    })))
}

/// Window control shared by the tray and the front end. Hiding is not quitting:
/// the process stays alive in the tray.
#[tauri::command]
pub async fn window_action(app: tauri::AppHandle, action: String) -> Reply {
    match action.as_str() {
        "show" => {
            crate::tray::show_main_window(&app);
            Ok(BridgeResponse::success(json!({"action": "show"})))
        }
        "hide" => {
            crate::tray::hide_main_window(&app);
            Ok(BridgeResponse::success(json!({"action": "hide"})))
        }
        "quit" => {
            log::info!("退出应用（前端请求）");
            app.exit(0);
            Ok(BridgeResponse::success(json!({"action": "quit"})))
        }
        _ => Ok(BridgeResponse::failure(
            "invalid_request",
            "Unsupported window action",
        )),
    }
}

/// One-line connectivity summary reused by the tray probe. Carries only the
/// core's error code and the client's own wording, never raw core text or the
/// credential.
pub async fn core_probe_summary() -> String {
    let client = match CoreClient::from_config() {
        Ok(client) => client,
        Err(error) => return format!("凭据不可用: {error}"),
    };

    let response = client.post("/v1/stats", json!({})).await;
    if response.ok {
        "核心已连接".to_string()
    } else {
        let code = response.code.unwrap_or_else(|| "core_error".into());
        format!("核心未连接 ({code})")
    }
}
