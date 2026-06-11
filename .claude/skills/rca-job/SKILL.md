---
name: rca-job
description: Root-cause analysis for a Watchtower / miniOG job using its job id. Use when the user says "check what happened to job", "RCA this job", "why did this job fail", "investigate job id", or provides a job UUID and asks what went wrong. Queries the local SQLite database, reads job metadata + full log trail, classifies the failure mode, and presents a structured diagnosis. Can also manually reply to Slack on behalf of miniOG and clean up failure artifacts (delete messages, swap reactions) when asked.
---

# RCA Job

Investigate a Watchtower job by its UUID. Produce a structured diagnosis from the SQLite database without touching the running sidecar.

## Database location

```
~/Library/Application Support/com.dipesh.watchtower/watchtower.db
```

Always quote the path with `$HOME/Library/Application\ Support/com.dipesh.watchtower/watchtower.db` or use `"$HOME/Library/Application Support/com.dipesh.watchtower/watchtower.db"` in shell commands.

## Step 1 — Pull the job record and logs

Run these two queries (replace `<JOB_ID>` with the UUID the user gave):

```bash
# Job row
sqlite3 "$HOME/Library/Application Support/com.dipesh.watchtower/watchtower.db" \
  ".headers on" ".mode line" \
  "SELECT id, status, workflow, channel_id, thread_ts, attempts, created_at, updated_at, error_message, substr(payload_json, 1, 800) AS payload, substr(result_json, 1, 800) AS result FROM jobs WHERE id='<JOB_ID>';"

# Full log trail
sqlite3 "$HOME/Library/Application Support/com.dipesh.watchtower/watchtower.db" \
  ".mode column" ".width 12 5 32 120" \
  "SELECT substr(created_at, 12, 12) AS time, level, stage, substr(message, 1, 300) AS msg FROM job_logs WHERE job_id='<JOB_ID>' ORDER BY id ASC;"
```

If the job doesn't exist, tell the user immediately and stop.

## Step 2 — Classify the failure mode

Read through the logs chronologically and match to one of these known patterns:

| Pattern | Signature | Typical cause |
|---------|-----------|---------------|
| **Stuck / orphaned** | `status = RUNNING`, no logs for > 5 min, last stage is mid-workflow (e.g. `workflow.repo.classified`, `agent.spawned`) | Sidecar restarted or codex process hung; `cleanupOrphanedRunningJobs` didn't run |
| **Timeout** | `error_message = 'Request timed out'` or `agent.timeout` stage | Codex CLI exceeded `timeoutMs`; or overall workflow time exceeded `prReviewTimeoutMs` / `bugFixTimeoutMs` / `pmTaskTimeoutMs` |
| **Classification failure** | `router.classify.fallback` at WARN | AI classifier call failed → fell back to wrong intent (usually IMPLEMENTATION at 0.50 confidence) |
| **Access denied** | `access.enforce.denied` or `access.dm.denied` or `access.audit.would_deny` | User not in the right access group, or DM without `allowIm` |
| **Pipeline abort** | `pipeline.abort` at ERROR after `pipeline.agent.reviewer.finish: failed` | Reviewer found critical issues; but PR may already be pushed (check `result_json` for `prUrl`) |
| **Codex crash** | `agent.process.exit` with non-zero `exitCode` in data, no `agent.output.parsed` | Codex CLI crashed or failed to produce valid output |
| **Workspace / repo issue** | `implementation.workspace.fallback` at WARN | Wrong repo detected; worktree may have branched from wrong base (see issue #122) |
| **Quick action timeout** | `implementation.quick_action` followed by timeout | Planner said no code changes, but the quick-action codex took too long |
| **Slack post failed** | No `*.slack.posted` stage after `*.done` | Bot token expired, channel archived, or rate-limited |
| **PR review agent failed (per-PR)** | `agentic.pr_review.fallback.one_shot` at WARN then `agentic.pr_review.pr.failed` at ERROR | Agentic run AND its diff-only one-shot retry both failed for that PR; other PRs in the batch are unaffected — check `result_json.outcomes[]` per PR |
| **PR review paused for target choice** | `agentic.pr_review.targets.ambiguous` at WARN, `status = PAUSED` | Thread has several PR URLs and the ask had no selector — waiting on a reply ("web"/"api"/"both"/"#number"/URL) |

PR_REVIEW jobs are agentic since issue #334: stages are `agentic.pr_review.*` (`.targets.resolved`, `.pr.start`, `.pr.dedup_skipped`, `.pr.agent_done`, `.pr.github_review.submitted`, `.pr.summary_posted`, `.done`), one review run per PR, per-PR outcomes in `result_json.outcomes[]`. Deterministic routing logs `router.pr_review.deterministic` (no AI classifier involved). The legacy `pr_review.context.missing` stage is still the awaiting-URL pause key. A completed review with blocking findings is `SUCCESS` with `outcomes[].hasBlockingFindings = true` — only actual workflow failure is `FAILED`.

If the pattern doesn't match any known signature, say so and describe the anomaly.

## Step 3 — Present the diagnosis

Use this structure in your response to the user:

```
## Job `<JOB_ID>` — <STATUS> (<short cause>)

**Status:** `<status>` with `error_message = "<msg>"`

**Request:** <1-2 sentences from payload_json: who asked, what they asked, which channel/thread>

**What happened (timeline):**

| Time (UTC) | What |
|---|---|
| <ts> | <event> |
| ... | ... |
| <ts> | **<the failure point — bold it>** |

**Root cause:** <1 paragraph explaining the actual failure, referencing log stages>

**Impact:** <what the user experienced — e.g. "got a failure-doctor message instead of an answer", "no reply at all", "PR with wrong commits">
```

## Step 4 — Offer next actions

Based on the diagnosis, offer whichever of these are relevant:

### Manual reply (when miniOG failed to respond)
If the original Slack message deserved an answer that miniOG didn't deliver:
1. Read the bot token: `sqlite3 "$HOME/Library/Application Support/com.dipesh.watchtower/watchtower.db" "SELECT slack_bot_token FROM app_settings LIMIT 1;"`
2. Research the answer (use Explore agents against the repos listed in `newton_web_path` / `newton_api_path` from the same DB)
3. Post via `curl -s -X POST https://slack.com/api/chat.postMessage` with `channel`, `thread_ts`, `text`, and the bot token in the `Authorization: Bearer` header
4. Tag the original requester if the user asks (`<@UXXXXX>` in the Slack text)

### Clean up failure artifacts
If miniOG left failure messages or wrong reactions:
- **Delete messages**: `chat.delete` API with `channel` + `ts` (extract ts from Slack message URL: `p1776326513997509` → `1776326513.997509`)
- **Swap reactions**: `reactions.remove` (name `x`) then `reactions.add` (name `white_check_mark`) on the original message ts
- **Mark job**: `UPDATE jobs SET status='SUCCESS', error_message=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='<JOB_ID>';` (only when asked by the user)

### Suggest a code fix
If the failure points to a bug in the watchtower codebase, describe the bug with `file:line` references. Offer to open an issue via the `raise-watchtower-issue` skill.

## Useful supplementary queries

```bash
# All currently RUNNING jobs (stale job detector)
sqlite3 "$HOME/Library/Application Support/com.dipesh.watchtower/watchtower.db" \
  ".mode line" \
  "SELECT id, status, workflow, channel_id, created_at, updated_at FROM jobs WHERE status = 'RUNNING' ORDER BY created_at DESC;"

# Recent jobs (last 10)
sqlite3 "$HOME/Library/Application Support/com.dipesh.watchtower/watchtower.db" \
  ".mode line" \
  "SELECT id, status, workflow, substr(error_message, 1, 80) AS err, created_at FROM jobs ORDER BY created_at DESC LIMIT 10;"

# Job payload (full)
sqlite3 "$HOME/Library/Application Support/com.dipesh.watchtower/watchtower.db" \
  "SELECT payload_json FROM jobs WHERE id='<JOB_ID>';"

# Job result (full)
sqlite3 "$HOME/Library/Application Support/com.dipesh.watchtower/watchtower.db" \
  "SELECT result_json FROM jobs WHERE id='<JOB_ID>';"

# Bot token + repo paths
sqlite3 "$HOME/Library/Application Support/com.dipesh.watchtower/watchtower.db" \
  ".mode line" \
  "SELECT slack_bot_token, newton_web_path, newton_api_path FROM app_settings LIMIT 1;"

# Sidecar process check
pgrep -lf "sidecar/dist/index.js"
ps -o lstart=,etime=,pid= -p $(pgrep -f "sidecar/dist/index.js")
```

## Don'ts

- Don't restart, kill, or signal the sidecar — this skill is read-only against the process. The user will explicitly ask if they want a restart.
- Don't modify code or create PRs from this skill. Use `raise-watchtower-issue` if a code bug is found.
- Don't mark jobs as SUCCESS/FAILED unless the user explicitly asks.
- Don't delete Slack messages or swap reactions unless the user explicitly asks.
- Don't guess at root causes — if the logs don't match a known pattern, say "unknown failure mode" and quote the raw logs.
