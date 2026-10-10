---
name: agent-memory-backpack
description: Use when work in a project should follow its versioned Agent Memory Backpack knowledge, retrieve the complete workflow, or submit newly discovered experience for review.
---

Use the Agent Memory Backpack tools for project knowledge and candidate submission. The project's configured knowledge is authoritative for this workflow; do not invent missing policy or mark an unreviewed candidate as accepted.

1. Call `amb_prepare` at the start of applicable work to load the current revision, norms, workflows, and operating mode. If it fails, say the knowledge service is unavailable and do not claim that current project policy was checked.
2. Call `amb_search_workflows` for the user's goal and follow the returned complete-workflow entry. Use `amb_read_stage` to load a needed stage before acting; keep dependencies and missing required steps explicit.
3. When work reveals reusable experience, submit it with `amb_submit_experience` as a candidate. Report its receipt and pending state. Never promote it or edit active norms through agent tools.
4. Hooks may supply context, block a supported local tool call, and record a short event. Tool hooks do not cover every hosted or specialized path. A `Stop` event means only `turn_stopped`; it does not mean that the project task completed.

Only send short event summaries to the service. Do not include full tool output, credentials, or secrets in candidate submissions or event summaries.
