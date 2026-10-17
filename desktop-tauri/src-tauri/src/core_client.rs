use reqwest::{redirect::Policy, Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf, time::Duration};

#[derive(Serialize, Deserialize)]
pub struct BridgeResponse<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

impl<T> BridgeResponse<T> {
    pub fn success(data: T) -> Self {
        Self { ok: true, data: Some(data), error: None, code: None }
    }

    pub fn failure(code: &str, message: &str) -> Self {
        Self { ok: false, data: None, error: Some(message.into()), code: Some(code.into()) }
    }
}

// Never derive Debug: this structure contains the credential.
#[derive(Deserialize)]
struct Credential {
    endpoint: String,
    token: String,
    #[serde(rename = "projectId")]
    project_id: String,
    #[serde(default = "default_role")]
    role: String,
}

fn default_role() -> String { "adapter".into() }

pub struct CoreClient {
    endpoint: Url,
    credential: Credential,
    http: Client,
}

impl CoreClient {
    /// The core's own console, addressed the way the core itself publishes it.
    ///
    /// The desktop shell used to render its own front end from `desktop-tauri/src` (index.html,
    /// main.js, app.css - about 22KB, four panels, four buttons) and never loaded the console the
    /// core serves at `/ui` (ten tabs). That is why the user asked why the interface was missing
    /// so much: both surfaces were real, and the desktop was showing the smaller one. Returning
    /// this address lets the webview load the real console, so a change to the console reaches
    /// the desktop and the browser at the same time instead of being implemented twice.
    ///
    /// The credential travels in the URL fragment, which is the part a browser never sends to a
    /// server - it stays out of request lines and out of server-side logs.
    pub fn console_url(&self) -> String {
        format!("{}/ui#{}", self.endpoint.as_str().trim_end_matches('/'), self.credential.token)
    }

    pub fn from_config() -> Result<Self, String> {
        let explicit = env::var_os("AMB_CONSOLE_CONFIG").or_else(|| env::var_os("AMB_CONFIG"));
        let path = match explicit {
            Some(path) => PathBuf::from(path),
            None => {
                let home = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"))
                    .ok_or_else(|| "User home directory unavailable".to_string())?;
                PathBuf::from(home).join(".agent-memory-backpack").join("admin-client.json")
            }
        };
        let bytes = fs::read(path).map_err(|_| "Credential configuration could not be read".to_string())?;
        let credential: Credential = serde_json::from_slice(&bytes)
            .map_err(|_| "Credential configuration is invalid".to_string())?;
        Self::from_credential(credential)
    }

    fn from_credential(credential: Credential) -> Result<Self, String> {
        let endpoint = Url::parse(&credential.endpoint).map_err(|_| "Invalid core endpoint".to_string())?;
        // Match the core's current Host allowlist, which does not include IPv6.
        let loopback = matches!(endpoint.host_str(), Some("127.0.0.1") | Some("localhost"));
        if endpoint.scheme() != "http" || !loopback || !endpoint.username().is_empty()
            || endpoint.password().is_some() || endpoint.query().is_some()
            || endpoint.fragment().is_some() || endpoint.path() != "/"
            || endpoint.port_or_known_default().is_none()
        {
            return Err("Core endpoint must be a loopback HTTP origin".into());
        }
        if !(32..=256).contains(&credential.token.len())
            || credential.token.chars().any(char::is_control)
            || credential.project_id.is_empty()
            || !matches!(credential.role.as_str(), "admin" | "adapter")
        {
            return Err("Credential configuration is invalid".into());
        }
        let http = Client::builder().no_proxy().redirect(Policy::none())
            .timeout(Duration::from_millis(4500)).build()
            .map_err(|_| "HTTP client initialization failed".to_string())?;
        Ok(Self { endpoint, credential, http })
    }

    pub fn target(&self) -> Value {
        json!({ "endpoint": self.endpoint.as_str(), "projectId": self.credential.project_id,
            "adapter": self.credential.role, "role": self.credential.role })
    }

    pub fn is_admin(&self) -> bool { self.credential.role == "admin" }

    pub async fn post(&self, path: &str, body: Value) -> BridgeResponse<Value> {
        let valid_path = path.strip_prefix("/v1/").map(|tail| {
            !tail.is_empty() && tail.split('/').all(|part| !part.is_empty()
                && part.bytes().all(|c| c.is_ascii_lowercase() || c == b'-'))
        }).unwrap_or(false);
        if !valid_path {
            return BridgeResponse::failure("invalid_path", "Unsupported core path");
        }
        let mut object = match body.as_object() {
            Some(value) => value.clone(),
            None => return BridgeResponse::failure("invalid_request", "Request body must be an object"),
        };
        // Caller data cannot override the credential's project or adapter identity.
        object.insert("projectId".into(), json!(self.credential.project_id));
        object.remove("adapter");
        let url = match self.endpoint.join(path) {
            Ok(url) => url,
            Err(_) => return BridgeResponse::failure("invalid_path", "Unsupported core path"),
        };
        let response = match self.http.post(url).bearer_auth(&self.credential.token)
            .header("x-amb-protocol", "1").json(&object).send().await {
            Ok(response) => response,
            Err(_) => return BridgeResponse::failure("core_unavailable", "Core request failed or timed out"),
        };
        let status = response.status();
        let data: Value = match response.json().await {
            Ok(data) => data,
            Err(_) => return BridgeResponse::failure("invalid_response", "Core returned invalid JSON"),
        };
        if !status.is_success() {
            let code = data.get("code").and_then(Value::as_str).unwrap_or("core_error");
            // Do not forward untrusted core text that could contain a credential.
            let message = match code {
                "revision_conflict" => "Knowledge changed; refresh and review before retrying",
                "forbidden" => "This operation requires an admin credential",
                "scope_denied" => "The requested project or entry is outside this credential scope",
                "unauthorized" => "Credential expired or was rejected; reconnect",
                "invalid_request" => "Request fields are invalid",
                _ => "Core operation failed",
            };
            return BridgeResponse::failure(code, message);
        }
        BridgeResponse::success(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(endpoint: &str) -> Credential {
        Credential { endpoint: endpoint.into(), token: "x".repeat(64),
            project_id: "fixture".into(), role: "admin".into() }
    }

    #[test]
    fn rejects_remote_and_decorated_origins() {
        for endpoint in ["https://127.0.0.1:47631", "http://example.com", "http://user@localhost",
            "http://localhost/ui", "http://localhost?token=x", "http://localhost#secret"] {
            assert!(CoreClient::from_credential(config(endpoint)).is_err());
        }
    }

    #[test]
    fn public_target_contains_no_token() {
        let client = CoreClient::from_credential(config("http://127.0.0.1:47631")).unwrap();
        assert!(!client.target().to_string().contains(&"x".repeat(64)));
        assert_eq!(client.target()["projectId"], "fixture");
    }
}
