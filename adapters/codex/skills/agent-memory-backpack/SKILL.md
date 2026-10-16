---
name: agent-memory-backpack
description: Use in any project session to search the shared Agent Memory Backpack library for relevant knowledge, experience and journals, retrieve complete workflows, and submit verified discoveries for review.
---

Use the Agent Memory Backpack tools for project knowledge and candidate submission. The project's configured knowledge is authoritative for this workflow; do not invent missing policy or mark an unreviewed candidate as accepted.

1. Call `amb_prepare` at the start of applicable work to load the current revision, norms, workflows, and operating mode. If it fails, say the knowledge service is unavailable and do not claim that current project policy was checked.
2. Proactively call `amb_search_universal` with focused task keywords to find knowledge, experience and journals across the shared library. Read the relevant hits using `amb_read_knowledge`; an excerpt is not a complete procedure. Narrow a noisy query; do not load unrelated diaries. Call `amb_search_workflows` for complete workflows and use `amb_read_stage` before executing a stage.
3. When work reveals reusable experience, submit it with `amb_submit_experience` as a candidate. Report its receipt and pending state. Never promote it or edit active norms through agent tools.
4. Hooks may supply context, block a supported local tool call, and record a short event. Tool hooks do not cover every hosted or specialized path. A `Stop` event means only `turn_stopped`; it does not mean that the project task completed.
5. After a materially new failure, search once using the operation and stable error signature. Structured failures may be captured automatically as unverified candidates. After verifying the cause and recovery, submit the reusable conclusion with its workflow/stage, reproduction, fix and evidence. Report whether it is pending in the core or queued locally; neither means accepted.
6. At a meaningful milestone or before ending work, call `amb_checkpoint_task` with the actual progress, unfinished items, and verification evidence. Mark completed only after verifying completion. Submit any reusable discovery separately with `amb_submit_experience`; a task journal is not an adopted rule. Use `amb_task_activity` to inspect persistence receipts. Host stop hooks save an unverified journal as a fallback and never invent a successful result.

Only send short event summaries to the service. Do not include full tool output, credentials, or secrets in candidate submissions or event summaries.
