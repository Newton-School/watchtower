# Model & Reasoning-Effort Audit — Opus 5 / Sonnet 5 migration

**Date:** 2026-08-03 · **Live backend:** `claude-code` (`app_settings.agent_backend`) · **CLI:** `claude` 2.1.220

Every model and effort decision in the sidecar resolves through **one 24-line table**:
`sidecar/src/codex/modelProfiles.ts`. There are exactly three claude-code values in it, and
they set the model for all 40+ agent call sites in the system.

---

## 1. The whole system, in three values

| Tier | Model | Effort | Feeds |
|---|---|---|---|
| `lightweight` | `claude-sonnet-4-6` | `low` | all routing, all classifiers, verifier, PR-review verification, learning |
| `highReasoning` | `claude-opus-4-7` | `high` | coder, reviewer, security, investigation, implementation, deploy, PR review, QA, informational |
| planner override | `claude-opus-4-7` | `max` | the planner only (claude-code branch, `modelProfiles.ts:55-59`) |

Codex column (`gpt-5.2-codex` @ `low` / `gpt-5.4` @ `xhigh`) is **not live** — zero codex rows in the DB.

### Recommended

| Tier | Now | → Change to | Why |
|---|---|---|---|
| `lightweight` | `claude-sonnet-4-6` @ `low` | **`claude-sonnet-5` @ `low`** | Same list price ($3/$15), $2/$10 intro through 2026-08-31. Near-Opus quality on the JSON-classification work these calls do — and JSON adherence is the failure mode that matters here (§4.1). |
| `highReasoning` | `claude-opus-4-7` @ `high` | **`claude-opus-5` @ `xhigh`** | Identical price ($5/$25). `xhigh` is Anthropic's documented setting for coding/agentic work and Claude Code's own default — the current `high` is *below* guidance. Opus 5 is a step change on long-horizon agentic execution. |
| planner override | `claude-opus-4-7` @ `max` | **`claude-opus-5` @ `xhigh`** | `max` is documented as prone to overthinking with diminishing returns. Opus 5 @ `xhigh` ≥ Opus 4.7 @ `max` in practice, at lower latency. This path runs up to **3× per job with no timeout** — the single largest cost line in the system. |
| codex column | `gpt-5.2-codex` / `gpt-5.4` | **leave alone** | Nothing runs on it; changing it breaks 9 test assertions for zero production benefit. |

Net: better models, lower planner spend, **no price increase on either tier**.

---

## 2. Full call-site inventory

Grouped by workflow. "Tier" is what resolves today on the live claude-code backend.
Line numbers verified 2026-08-03; `pipeline.ts` / `implementationWorkflow.ts` were being edited
concurrently during the audit — re-confirm before using as edit anchors.

### INVESTIGATION

| Step | File | Tier → today | Recommend |
|---|---|---|---|
| Scope classifier (web / api / broad) | `router/investigationScope.ts:112` | light → sonnet-4-6 @ low | sonnet-5 @ low |
| Investigator (main diagnosis run, no timeout) | `workflows/investigationWorkflow.ts:189` | high → opus-4-7 @ high | **opus-5 @ xhigh** |

### IMPLEMENTATION

| Step | File | Tier → today | Recommend |
|---|---|---|---|
| Planner — initial plan | `implementationWorkflow.ts:788` | override → opus-4-7 @ **max** | **opus-5 @ xhigh** |
| Planner — clarification follow-up | `implementationWorkflow.ts:938` | override → opus-4-7 @ **max** | **opus-5 @ xhigh** |
| Planner — revision after admin feedback | `implementationWorkflow.ts:498` | override → opus-4-7 @ **max** | **opus-5 @ xhigh** |
| Planner (pipeline path) | `agents/pipeline.ts:1028` | override → opus-4-7 @ **max** | **opus-5 @ xhigh** |
| Coder | `agents/pipeline.ts:1046` | high → opus-4-7 @ high | **opus-5 @ xhigh** |
| Coder retry after reviewer reject (×2 max) | `agents/pipeline.ts:1316` | high → opus-4-7 @ high | **opus-5 @ xhigh** |
| Reviewer | `agents/pipeline.ts:967` (role loop) | high → opus-4-7 @ high | **opus-5 @ xhigh** |
| Verifier (final gate before PR) | `agents/pipeline.ts:967` (role loop) | light → sonnet-4-6 @ low | sonnet-5 @ **medium** (see §4.1) |
| Quick-action executor (no code needed) | `implementationWorkflow.ts:1102` | high → opus-4-7 @ high | **opus-5 @ xhigh** |
| Owner single-shot run | `implementationWorkflow.ts:1716` | high → opus-4-7 @ high | **opus-5 @ xhigh** |
| Owner relaxed retry | `implementationWorkflow.ts:1771` | high → opus-4-7 @ high | **opus-5 @ xhigh** |
| Approval-intent classifier (15s timeout) | `agents/pipeline.ts:230` | light → sonnet-4-6 @ low | sonnet-5 @ low + **raise timeout** |
| Repo-choice classifier (15s timeout) | `agents/pipeline.ts:553` | light → sonnet-4-6 @ low | sonnet-5 @ low + **raise timeout** |

`security` and `performance` roles never run in IMPLEMENTATION — the live agent list is
`['coder','reviewer','verifier']` (`implementationWorkflow.ts:1389`). They exist only via PR review.

### PR_REVIEW (agentic fan-out)

Fixed 3 lenses, not per-file. Worst case per job: 3 PRs × (3 lenses + 3 retries + 20 verifications) ≈ 78 CLI runs.

| Step | File | Tier → today | Recommend |
|---|---|---|---|
| Reviewer lens | `agentic/prReviewAgent.ts:340` | high → opus-4-7 @ high | opus-5 @ **high** (bounded — see §3.2) |
| Security lens | `agentic/prReviewAgent.ts:340` | high → opus-4-7 @ high | opus-5 @ **high** |
| Performance lens | `agentic/prReviewAgent.ts:340` | light → sonnet-4-6 @ low | sonnet-5 @ low |
| Tier-2 degradation retry (hardcoded `medium`) | `agentic/prReviewAgent.ts:381` | hardcoded `medium` | keep — but note it is an *upgrade* for the performance lens, not a degradation |
| Adversarial finding verifier (≤20/PR) | `agentic/prReviewAgent.ts:418` | light → sonnet-4-6 @ low | sonnet-5 @ low |
| One-shot collapse fallback | `agentic/prReviewAgent.ts:904` | high → opus-4-7 @ high | opus-5 @ high |

### Routing (every inbound Slack mention)

| Step | File | Tier → today | Recommend |
|---|---|---|---|
| Workflow-intent classifier (30s) | `router/classifyIntent.ts:118` | light → sonnet-4-6 @ low | sonnet-5 @ low + raise timeout |
| Repo classifier (30s) | `router/repoClassifier.ts:312` | light → sonnet-4-6 @ low | sonnet-5 @ low + raise timeout |
| Unknown-task reply generator | `workflows/unknownTaskWorkflow.ts:200` | light → sonnet-4-6 @ low | sonnet-5 @ low |
| Owner-autopilot template runner (no timeout) | `router/taskRouter.ts:438` | high → opus-4-7 @ high | opus-5 @ xhigh |

### Other

| Step | File | Tier → today | Recommend |
|---|---|---|---|
| DEPLOY executor (**prod side effect, no retry, no timeout**) | `workflows/deployWorkflow.ts:170` | high → opus-4-7 @ high | opus-5 @ xhigh — validate on a staging deploy first |
| WEBAPP_QA browser agent (20 min cap, pinned claude-code) | `agentic/agenticEntry.ts:310` | high → opus-4-7 @ high | opus-5 @ **high** (timeout-bound) |
| INFORMATIONAL / CONVERSATIONAL answer (**no timeout**) | `agentic/agenticEntry.ts:198` → `runClaude.ts:54` | high → opus-4-7 @ high | opus-5 @ **medium** — a one-line greeting is currently billed at Opus/high |
| Learning: user-profile synthesizer (60s, nightly) | `learning/profileSynthesizer.ts:170` | light → sonnet-4-6 @ low | sonnet-5 @ low |

`runClaude.ts` has **no parameter to choose a tier or effort** — every informational, conversational
and QA run is hardcoded to the high tier at `runClaude.ts:54`. Adding an optional `effort` to
`RunClaudeAgenticRequest` is the cheapest single cost win in the codebase.

---

## 3. Blockers — must land with the swap

### 3.1 Price table (hard blocker)

`sidecar/src/pricing/modelPrices.ts` is **not** a fallback despite its docstring — it is the primary
cost source: live DB shows **1421 `computed` vs 5 `reported`**. Change the model ids without adding
price keys and every new run writes `cost_usd = NULL` silently; the Performance page collapses to $0.00.

Add:

```ts
'claude-opus-5':   { inputPer1k: 0.005, outputPer1k: 0.025, cacheReadPer1k: 0.0005, cacheCreatePer1k: 0.00625 },
'claude-sonnet-5': { inputPer1k: 0.003, outputPer1k: 0.015, cacheReadPer1k: 0.0003, cacheCreatePer1k: 0.00375 },
```

**Also fix an existing bug:** `claude-opus-4-7` is priced at `0.015`/`0.075` — i.e. **$15/$75 per MTok**.
Actual Opus 4.7 list price is **$5/$25**. Every opus row is inflated ~3×: the DB shows **$219.94**
across 122 calls where the true figure is ≈ **$73**. Correct it to `0.005`/`0.025` (cache `0.0005`/`0.00625`).
Historical rows are frozen at write time and will not self-correct.

Keep the legacy `-20250514` entries — `modelPrices.test.ts` and `jobStoreAgentCalls.test.ts` key off them.

### 3.2 Timeouts — the silent-failure surface

Every classifier timeout fails **silently into a wrong answer**, never an error:

| Site | Now | Failure mode if exceeded | Recommend |
|---|---|---|---|
| `pipeline.ts:236` approval classifier | 15s | returns null → gate never advances, re-spawns every 5s poll | **30s** |
| `pipeline.ts:559` repo-choice classifier | 15s | → `'unclear'`, admin's answer ignored for 6h | **30s** |
| `classifyIntent.ts:125` | 30s | → INFORMATIONAL/NONE (misroute) | **45s** |
| `repoClassifier.ts:318` | 30s | → `'uncertain'`, punts to desktop | **45s** |
| `investigationScope.ts:119` | 30s | → `'broad'`, which also switches **Metabase MCP on** | **45s** |
| `profileSynthesizer.ts:177` | 60s | profile synthesis skipped | **90s** |
| `prReviewTimeoutMs` (DB) | 12 min | applied in full **per lens AND per verifier run** | **20 min** |

Opus 4.7 @ `high` already peaks at **52 min** (max observed in `agent_calls`) against a 12-minute PR-review
budget. Moving that tier to `xhigh` without raising `prReviewTimeoutMs` converts passing lenses into
timeouts → `medium` retries → doubled spend → possible total collapse to the diff-only one-shot.
This is why the PR-review lenses are recommended at `high`, not `xhigh`, until the budget is raised.

### 3.3 Sync the second and third copies of the model ids

- `backends/claudeCodeBackend.ts:387` `availableModels()` — **dead code, zero callers**. Cosmetic, but stale = misleading.
- `backends/claudeCodeBackend.ts:391` `defaultModel()` — **live**: `runCodex.ts:274` writes it to `agent_calls.model` whenever a call omits a model. No call site omits one today, so it is latent.

### 3.4 Stale self-description in the DB

`user_memories` rows **28, 40, 56, 161** assert the bot's own model — two of them still name
`claude-opus-4-20250514`, one names `claude-opus-4-7`. These are replayed into prompts by
`codex/recallAssembler.ts`, so after the swap miniOG can be primed with its own obsolete model id.
Delete or rewrite them.

### 3.5 Stale comment

`workflows/investigationWorkflow.ts:197` justifies having no timeout with *"Claude Opus at max reasoning"* —
that call actually resolves to `high`, not `max`. Already wrong; three other sites defer to this comment.

---

## 4. What the migration does NOT fix (and could make worse)

### 4.1 JSON adherence is unenforced on the live backend

`outputSchemaPath` is consumed **only** by `codexBackend.ts:152`. `claudeCodeBackend.buildArgs` ignores it
entirely — so on the live backend every JSON contract is prompt-only ("Return strict JSON").

Worse, `claudeCodeBackend.parseOutput` wraps plain prose as `{status:'success', summary:<prose>}`. Consequences:

- `determineStepStatus` sees no `approved`/`verified` key → scores the step **`passed`**. A reviewer that
  writes *"I found a critical bug"* in prose is a green step.
- The `!result.parsedJson` failure branches in `classifyIntent.ts:128`, `repoClassifier.ts:321` and
  `investigationScope.ts:122` **can never fire** on claude-code.
- The PR-review verifier **fails open** (`prReviewAgent.ts:444`) — an unparseable verdict confirms every finding.

Sonnet 5 and Opus 5 both follow instructions *more* literally than their predecessors, so this should
improve — but the migration does not close the hole. Enforcing structure on claude-code (or at minimum
logging a WARN when a JSON-expecting call returns prose) is a separate, higher-value fix.

### 4.2 No test covers the column that runs

`activeBackendId` defaults to `'codex'` (`runCodex.ts:26`) and no test calls `setActiveBackend('claude-code')`
for a model assertion. **Changing all three claude-code values breaks zero of the 999 tests** (verified: full
suite green in 3.5s). Conversely, touching the dead codex column breaks 9 assertions across 3 files.
Add one test that pins the claude-code tier before migrating, or the change ships unverified.

### 4.3 Sonnet 5's tokenizer produces ~30% more tokens than Sonnet 4.6

For the same text. `codex/recallAssembler.ts:28-38` estimates tokens as `chars/4` and budgets from it
(1500 IMPLEMENTATION / 1200 INVESTIGATION / …). The heuristic drifts under the new tokenizer; it fails
safe by dropping blocks, but recall quality degrades quietly. Re-baseline if recall gets thin.

### 4.4 No runtime lever for the live backend

`WATCHTOWER_LIGHTWEIGHT_CODEX_MODEL` / `WATCHTOWER_HIGH_REASONING_CODEX_MODEL` override the **codex**
column only, at module-load time, and are documented nowhere (absent from `.env.example`). The claude-code
ids are hardcoded — changing the model that actually runs requires a code edit, rebuild and restart.
Worth adding `WATCHTOWER_CLAUDE_{LIGHTWEIGHT,HIGH_REASONING}_MODEL` in the same commit so the next swap
is a config change.

---

## 5. Suggested sequencing

1. **Fix the opus-4-7 mispricing** + add `claude-opus-5` / `claude-sonnet-5` price keys. Independent, no risk.
2. **Raise the six timeouts** in §3.2 and `prReviewTimeoutMs`. Independent, strictly safer.
3. **Add a claude-code tier test** so step 4 is verifiable.
4. **Swap `lightweight` → `claude-sonnet-5` @ `low`.** Lowest blast radius; watch the classifier fallbacks
   in `job_logs` (`router.classify.*`, `investigation.scope.fallback`) for a day.
5. **Swap `highReasoning` → `claude-opus-5` @ `xhigh`** and the **planner override → `claude-opus-5` @ `xhigh`**.
   Watch p95 duration on `agent_calls` against `prReviewTimeoutMs` and `QA_TIMEOUT_MS`.
6. **Clean up:** `availableModels()`/`defaultModel()`, the stale `user_memories` rows, the
   `investigationWorkflow.ts:197` comment, and the "Sonnet for volume, Opus for the hard reasoning"
   copy in `docs/linkedin-miniog-collateral.md`.

Optional follow-ups, in value order: an `effort` parameter on `runClaude.ts` (informational runs are
currently Opus-tier); enforcing JSON structure on the claude-code backend (§4.1); Haiku 4.5 for the pure
classifiers — **prerequisite:** Haiku 4.5 rejects the `effort` parameter, so `reasoningEffort` would have
to become optional per profile first.
