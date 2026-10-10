# Codex desktop hooks trust entry: read-only inspection

Inspection target: the installed AppX build, at `<Program Files>/WindowsApps/OpenAI.Codex_<version>_x64__<publisher-hash>/app/resources/app.asar` (561,628,354 bytes). Parsed only the ASAR header and read selected bundle entries by their recorded offsets; did not extract the archive or interact with the desktop UI.

## Confirmed in the installed bundle

- `webview/assets/hooks-settings-route-8191acda142e.js` sets the section to `hooks-settings` and base path to `/settings`; its route helper constructs `/settings/hooks-settings` when no source filter is supplied.
- `webview/assets/hooks-settings-88e3beb5a5e5.js` contains a visible `Trust all` action. Its UI description is “Trust all new or modified hook definitions in the currently open source.” The same component reports hook issue counts and “needs review” counts.
- `webview/assets/hooks-settings-model-f200bbc1bcb6.js` classifies hook definitions with `trustStatus` values `untrusted` or `modified` as needing review. It recognizes `plugin` as a hook source.
- `webview/assets/hooks-settings-source-label-c4b91800f6fe.js` describes the source field as “the project, plugin, or configuration that defines a hook.” This ties the review page to plugin-defined hooks as well as project/user hooks.

This is concrete evidence that the installed package contains a Hooks settings/review UI and a trust action. A reasonable place to look is Settings → Hooks (route `/settings/hooks-settings`); the bundle text points to reviewing definitions for the currently selected source, including plugin sources.

## Not confirmed

Bundle presence does not prove the route is exposed in this running session, that a particular plugin hook appears in the list, or that a trust prompt should appear during plugin installation. No feature-flag evaluation, route navigation, project fixture, hook hash, trust record, or live UI state was inspected. The current project list lacks a disposable fixture project, so plugin discovery and per-project hook review remain untested. No configuration, trust state, installation, or running desktop process was changed.
