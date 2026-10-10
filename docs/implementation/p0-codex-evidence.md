# P0 evidence: Codex desktop integration

Collected 2026-10-09 (Asia/Shanghai). Scope: read-only evidence for the DSH/Codex knowledge-plugin design. No plugin was installed, no profile/configuration was changed, and no credential-bearing file was read. This report does not claim a plugin or MCP fixture was run.

## Version and local state

| Item | Evidence | Finding |
|---|---|---|
| Codex desktop | Codex app `check_app_update` read-only result | Installed version `26.1002.52244`, build `13536`, release channel `prod`. The status was `unavailable` because Windows Store installation eligibility requires a Store check; the API still returned the installed version. |
| Codex CLI | `codex.exe --version` from the installed Codex binary directory | `codex-cli 0.162.0-alpha.2`. This is CLI evidence only and is not used as the desktop version. |
| Desktop process | `Get-Process` | `codex` desktop processes were running from `<USER_HOME>\AppData\Local\OpenAI\Codex\bin\9691020b546a15b2\codex.exe`. |
| User plugin area | Directory names only under `<USER_HOME>\.codex\plugins` | Contains `.plugin-appserver`, `.remote-plugin-install-staging`, and `cache`. No contents or configuration were opened. Cached skill and `.mcp.json` filenames exist under `cache`; this proves only local packaged resources exist, not that any specific plugin is enabled or usable. |
| Marketplace/config in this repo | `Test-Path` checks only | `<PROJECT_ROOT>\.agents\plugins\marketplace.json` and `<PROJECT_ROOT>\.codex\config.toml` do not exist. Personal `<USER_HOME>\.agents\plugins` does not exist. |

## Capability matrix

| Capability | Officially documented behavior | Evidence and confidence |
|---|---|---|
| Plugin composition | Skills, MCP servers, and optional UI can be packaged together. Portable packages use root `plugin.json`, `mcp.json`, `skills/`; Codex compatibility packages use `.codex-plugin/plugin.json`, `.mcp.json`, and `skills/`. Existing compatibility manifests remain supported. | Official [Package your plugin](https://developers.openai.com/plugins/build/plugins) and [plugin architecture](https://developers.openai.com/plugins/concepts/plugins). Documented; not exercised in this session. |
| MCP in desktop | Bundled MCP servers are supported; users can enable/disable a bundled server and set tool approval policy. Codex's local marketplace flow is installed and tested through the desktop UI. | Official [Package your plugin](https://developers.openai.com/plugins/build/plugins), [MCP server](https://developers.openai.com/plugins/concepts/mcp-server). Not exercised locally. |
| Plugin lifecycle hooks | Hooks are supported for manually installed Codex desktop plugins. Hook files can be declared in the manifest or discovered as `hooks/hooks.json`. Hooks are excluded from public plugin-directory eligibility. | Official [Package your plugin](https://developers.openai.com/plugins/build/plugins), [Hooks](https://developers.openai.com/codex/hooks). Documented; not exercised in this session. |
| Hook trust | Installing/enabling does not trust plugin hooks. Codex skips plugin-bundled hooks until the user reviews and trusts the current hook definition; trust is tied to the current hook hash, and changed definitions require a new review. The docs explain `/hooks` in the CLI for inspecting/reviewing/trusting hooks, but do not establish a distinct desktop UI flow. | Official [Hooks](https://developers.openai.com/codex/hooks). Explicit user trust is required. For desktop validation, exercise and record the trust flow in the desktop UI; do not count CLI trust as desktop UI evidence. |
| Skill auto-activation | The model sees skill metadata, then loads the full skill when the user request matches it or directly invokes it. The `description` should state user goal and trigger conditions. This is model-selected behavior, not a deterministic event hook or guaranteed classifier. | Official [Skills](https://developers.openai.com/plugins/concepts/skills), [Build skills](https://developers.openai.com/plugins/build/skills). For the DSH/Codex workflow, a focused skill description is the documented automatic entry point; test both positive and negative prompts. |
| `PreToolUse` / `PostToolUse` coverage | Supported: shell commands, unified `exec_command` (matcher alias `Bash`), `apply_patch` (also `Edit`/`Write` aliases), MCP tools by tool name, and most local function tools. Hosted tools such as `WebSearch` are not covered. Some specialized paths may opt out; docs say hooks are not a complete enforcement boundary. A `write_stdin` poll does not repeat `PreToolUse`. | Official [Hooks: tool coverage](https://developers.openai.com/codex/hooks), lines 1243-1256 in the fetched docs. Do not claim full tool interception. |
| Hook block behavior | `PreToolUse` can block supported calls or rewrite input. Unsupported output fields fail open for tool execution; for example `continue`, `stopReason`, or `suppressOutput` are not supported for this event. | Official [Hooks](https://developers.openai.com/codex/hooks). Treat hook output schema correctly and keep this out of the security boundary. |
| Marketplace shape | Repo marketplace path is `$REPO_ROOT/.agents/plugins/marketplace.json`; personal path is `~/.agents/plugins/marketplace.json`. Entries use a plugin source path relative to the marketplace root and `./` prefix. The desktop UI installs and tests local marketplace plugins. | Official [Package your plugin](https://developers.openai.com/plugins/build/plugins). |

## Actual manifest formats to target

The official docs currently describe both the portable Agent Plugins package and the Codex compatibility form. They are related but not interchangeable by renaming files:

```text
portable plugin root/
  plugin.json                  # identity, version, description, extensions.com.openai
  mcp.json                     # portable MCP schema (server has a transport type)
  skills/<skill>/SKILL.md
  hooks/hooks.json             # optional; supported for manually installed Codex desktop plugins
```

```text
Codex compatibility plugin root/
  .codex-plugin/plugin.json    # declares skills and mcpServers paths
  .mcp.json                    # Codex plugin MCP format
  skills/<skill>/SKILL.md
  hooks/hooks.json             # optional
```

Official examples show the compatibility manifest referencing `"skills": "./skills/"` and `"mcpServers": "./.mcp.json"`; its `.mcp.json` has a named `mcpServers` object. Portable `mcp.json` uses the Agent Plugins MCP schema, including a `type` transport such as `streamable-http`. Paths must be relative to the plugin root and remain within that root. When portable `plugin.json` has `extensions.com.openai`, that object replaces the compatibility overlay rather than merging with it.

## Isolated validation proposal (not run)

The repo-scoped marketplace is the smallest documented source scope, but desktop installation still writes user-level plugin choice state and a cached plugin copy. Official docs place cache under `~/.codex/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME/$VERSION/` (`local` for local plugins), and say the plugin browser stores enable/disable choices in `~/.codex/config.toml`. For the strict requirement “do not modify the real profile,” use a disposable Windows user or VM with a separate Codex desktop profile for the UI phase. Keep all fixture files in a throwaway local Git repo and do not add any global marketplace or user `config.toml` entry.

1. In the disposable environment, create a fixture repo with `.agents/plugins/marketplace.json`, `plugins/p0-fixture/.codex-plugin/plugin.json`, `plugins/p0-fixture/.mcp.json`, and `plugins/p0-fixture/skills/p0-fixture/SKILL.md`. Add the project-local enable entry in that fixture repo's `.codex/config.toml`. Use only a local deterministic MCP server with static fixture records; no network calls, secrets, external accounts, or write-capable tools.
2. Restart Codex desktop, open the fixture repo as a trusted project, open Plugins Directory, select the repo marketplace, and browse/install the fixture plugin. This is the documented desktop host-validation entry point. Do not use `codex plugin marketplace add` or CLI plugin tests as a substitute for this desktop check; the CLI is documented as an authoring/catalog helper, while installation and testing of a local plugin are directed to desktop UI.
3. Declare a narrow skill trigger describing a recognizable DSH/Codex request (cross-surface knowledge retrieval, versioned rules, candidate submission, or task continuation). In fresh desktop chats, try direct, indirect, incomplete, and unrelated prompts. Record whether the skill is considered/loaded and whether it causes the expected MCP lookup. Skill auto-activation is model behavior, so the expected result is a bounded activation rate, not a hard guarantee.
4. In the fixture only, add a `PreToolUse` hook matcher for the fixture MCP tool. Have it append a non-sensitive marker to a fixture-local log. Review and trust the exact hook definition through the desktop trust UI if available; if the desktop flow is not exposed or documented, record that as an unresolved host limitation rather than using CLI trust to claim desktop behavior. Then invoke the fixture tool and inspect the marker. Also issue a hosted-tool request to confirm that it does not appear in the local hook log. This is an observed limitation check, not a test of all special tool paths.
5. Disable/uninstall the fixture from that disposable environment and verify that the fixture MCP tool and skill no longer appear in a fresh chat. Preserve the marketplace, manifest, hook log, desktop version, and test prompts/results as the reproducible evidence bundle.

Before running this proposal against a desktop build, confirm that build `26.1002.52244` exposes the local marketplace UI and hook trust review as documented. The current report establishes docs support and the installed app version, but local runtime behavior remains unverified.

## Evidence references

- OpenAI `Package your plugin`: https://developers.openai.com/plugins/build/plugins
- OpenAI `Plugin architecture`: https://developers.openai.com/plugins/concepts/plugins
- OpenAI `Skills`: https://developers.openai.com/plugins/concepts/skills
- OpenAI `Build skills`: https://developers.openai.com/plugins/build/skills
- OpenAI `MCP server`: https://developers.openai.com/plugins/concepts/mcp-server
- OpenAI `Hooks`: https://developers.openai.com/codex/hooks (redirects to the current hooks documentation at `learn.chatgpt.com/docs/hooks`)
