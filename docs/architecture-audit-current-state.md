# miniOG / Watchtower — Current State Audit

> **Purpose.** Before we redesign the architecture, document what we have today and which parts keep breaking. Every "known failure" below links to the PR that tried to fix it, so we can see at a glance whether the fix landed at the right layer or just patched a symptom.
>
> This is a working doc — append, redirect, or rewrite as we learn more.
>
> **Update (2026-10).** The redesign this audit prepared for has started. `classifyIntent` (the LLM intent classifier), the learned intent corrections and the file-based workflow templates were deleted; the tool-router (`sidecar/src/router/toolRouter.ts`, issue #456) decides what a message asks for. The pipeline sketch below is the state before that.

---

## 1. Pipeline at a glance

```
Slack event
  ↓
Slack socket ingress  (sidecar/src/slack/*)
  ↓
normalizeTask          (mention detection, PR context, dedupe)
  ↓
classifyIntent         (LLM router → WorkflowIntent + confidence)
  ↓
taskRouter             (access control, repo resolve, classifier override)
  ↓
workflows/<intent>     (TS pipeline → codex/claude code → Slack reply)
  ↓
job_logs + jobs        (SQLite persistence, status, result)
  ↓
desktop notification + optional follow-ups
```

Every arrow is a decision point that the TS shell makes *before* the LLM gets to think. Each box in `workflows/*` then **further constrains** the LLM with schema'd prompts and "follow EXACTLY" framing.

---

## 2. Flows we have today

Intent enum: `sidecar/src/types/contracts.ts:5-16`.

| Intent              | Workflow file                       | Trigger heuristic                                                                 | Returns                              |
|---------------------|-------------------------------------|----------------------------------------------------------------------------------|--------------------------------------|
| `PR_REVIEW`         | `prReviewWorkflow.ts`               | Slack message contains a GH PR URL + tag                                          | inline PR comments + Slack summary   |
| `IMPLEMENTATION`    | `implementationWorkflow.ts`         | Tagged ask to build/change code (multi-agent: planner → coder → reviewer → verifier) | branch + PR + Slack PR URL           |
| `INVESTIGATION`     | `investigationWorkflow.ts`          | "What's wrong with X" / "why is Y broken"                                         | findings + "want me to fix?" prompt  |
| `INFORMATIONAL`     | `agentic/agenticEntry.ts` (`mode: 'informational'`) **[migrated D2 — agentic]** | "Where is X" / "how does Y work" / docs lookup | Slack answer |
| `CONVERSATIONAL`    | `agentic/agenticEntry.ts` (`mode: 'conversational'`) **[migrated D3 — agentic]** | Greetings, status checks, low-confidence fallback | Slack reply (no code work) |
| `DEPLOY`            | `deployWorkflow.ts`                 | Admin-only — explicit deploy ask                                                  | runs `deploy-prod.md` skill → Slack  |
| `DEV_ASSIST`        | `devAssistWorkflow.ts`              | DM ingestion, mission swarm, miniOG-as-coworker                                   | varies                               |
| `MINIOG_DOSSIER`    | `miniogDossierWorkflow.ts`          | `/miniog`, `/remember`, `/forget`, `/whoami` slash commands                       | dossier read/write                   |
| `OWNER_AUTOPILOT`   | `implementationWorkflow.ts` (split) | Owner-tagged builder request, looser gating                                       | same as IMPLEMENTATION               |
| `UNKNOWN`           | `unknownTaskWorkflow.ts`            | Classifier gave up / no clear match                                               | desktop-notify only                  |
| `NONE`              | —                                   | Sentinel for non-actionable events                                                | drop                                 |

Plus router-internal "pseudo-flows":
- **Repo resolver** (`router/repoClassifier.ts`, now LLM-driven per #270 + #308) — picks newton-web vs newton-api
- **Investigation resume gate** (`router/investigationResumeGate.ts`) — turns "yes fix it" into a real IMPLEMENTATION
- **Paused resume** (`router/pausedResume.ts`) — wakes a PAUSED job when its missing context arrives
- **DevAssist parser** + **Intent parser** + **Resume intent parser** + **Product classifier** — four more small classifiers each with their own failure surface

---

## 3. Known failures — per flow, with PR refs

### 3.1 `PR_REVIEW`

| Symptom                                                                                              | Root cause                                                                                  | Fix PR        |
|------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|---------------|
| Multi-agent silently **approved** the PR even when GitHub returned empty diff                        | Wrapper treated empty diff as "no findings" instead of as a fetch error                     | #285 / #291   |
| 887-file PR got "PR diff fetch returned empty" — review never ran                                    | GitHub caps `.diff` endpoint at 300 files (406 too_large); wrapper had no fallback           | #310          |
| Reviewers posted REQUEST_CHANGES on stylistic findings; people couldn't merge                        | Wrapper hardcoded review event without judging severity                                     | #193          |
| Inline comments rejected by GitHub because line wasn't in the diff                                   | TS validator didn't intersect findings with diff hunks                                      | #143          |
| Verifier said "fail" but workflow still tried to attach a PR comment                                 | Pipeline didn't honor abort                                                                 | #229          |
| "Review Changes" UI button shown while `job_diffs` was still being populated                         | Frontend raced backend write                                                                | #237          |
| Paused PR review with missing PR URL never resumed when the URL arrived in-thread                    | Gate keyed off wrong log stage                                                              | #222 / #224 / #227 |
| Wrong repo opened, plan ran against wrong codebase                                                   | Repo resolver used keyword match → wrong worktree                                           | #122 / #129 / #270 / #307 / #308 |
| **Still open / partial**: review of an open PR that's still building no-op'd or gave shallow review  | Wrapper has no notion of "wait for CI"                                                      | —             |

### 3.2 `IMPLEMENTATION` (planner → coder → reviewer → verifier)

| Symptom                                                                                              | Root cause                                                                                  | Fix PR        |
|------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|---------------|
| Coder JSON said "done", git showed no changes — false success                                        | Trusted self-report instead of git state                                                    | #133          |
| Planner returned empty plan; workflow continued and produced empty PR                                | Didn't fail-closed on no-steps                                                              | #231          |
| Planner SIGKILLed mid-thought after 6:45m                                                            | Per-agent timeout shorter than planner's actual think time                                  | #306          |
| Coder produced empty output → retry loop                                                             | Should have asked for input                                                                 | #135          |
| Worktree branched from wrong base after plan revision swapped repos                                  | Worktree resolved once at start; not re-resolved on revision                                | #271          |
| AbortSignal not threaded into runCodex — cancellations didn't actually stop work                     | Plumbing miss                                                                               | #251          |
| Planner using Claude Code "plan mode" blocked on permission_denials                                  | Output extraction didn't read the right field                                               | #268 / #275   |
| Replan silently re-posted old plan when JSON parse failed                                            | No surface of parse failure                                                                 | #205 / #206   |

### 3.3 `INVESTIGATION` (added #141)

| Symptom                                                                                              | Root cause                                                                                  | Fix PR        |
|------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|---------------|
| Tagged `<@miniOG> yes, fix it` → routed to CONVERSATIONAL, hallucinated "fix is done"                | No pre-classifier resume gate; classifier dropped access at low confidence                  | #299 / #302   |
| Conversational workflow then claimed the fix shipped — no code, no PR                                | No system-prompt guardrail against false completion claims                                  | #300          |
| Untagged `yes fix it` never reached the bot                                                          | Slack doesn't deliver un-mentioned channel msgs; needed reaction-based resume                | #301          |

### 3.4 `DEPLOY`

| Symptom                                                                                              | Root cause                                                                                  | Fix PR        |
|------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|---------------|
| Slack post failure caused workflow to retry → **duplicate deploy** in worst case                      | Errors from final Slack post escaped to retry loop                                          | #287 / #294   |
| **Still open (today's case)**: revert PR pending CI, deploy script picked older-success hash, said "no-op", left prod on the bad code | Python script's `success` fallback ignores user intent to deploy the pending commit | — (filed via thread `p1779462052872819`) |
| Wrapper says *"Follow the deployment instructions below EXACTLY. Do not deviate"* — agent can't reason about the situation | Architectural: wrapper-owned, not agent-owned                                                | —             |

### 3.5 `CONVERSATIONAL`

| Symptom                                                                                              | Root cause                                                                                  | Fix PR        |
|------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|---------------|
| Claimed code was shipped when nothing happened (see 3.3)                                             | No guardrail; system prompt didn't forbid fake completion claims                            | #300          |
| Role-unaware tone — same reply to PM and senior dev                                                  | No dossier/role plumbing                                                                    | #195 / #196   |
| Access-denial copy too curt                                                                          | Hardcoded string; didn't route by reason                                                    | #153 / #197   |

### 3.6 `INFORMATIONAL`

| Symptom                                                                                              | Root cause                                                                                  | Fix PR        |
|------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|---------------|
| Could only answer about one repo at a time                                                           | Hardcoded single-repo fanout                                                                | #147          |
| Self-inquiry ("what can you do") routed wrong                                                        | No target intent for "about miniOG itself"                                                  | #150 / #151   |
| Classifier failure produced an UNKNOWN instead of a best-effort answer                               | No fallback to INFORMATIONAL                                                                | #280 / #292   |
| Analyst-style BA questions handled like generic info                                                 | No role-specific path                                                                       | #199          |

### 3.7 `DEV_ASSIST`

| Symptom                                                                                              | Root cause                                                                                  | Fix PR        |
|------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|---------------|
| Reported SUCCESS for mission swarm runs even when no work was done                                   | Status calculation didn't reflect actual side effects                                       | #286 / #288   |

### 3.8 Ingress / dedupe / catch-up

| Symptom                                                                                              | Root cause                                                                                  | Fix PR        |
|------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|---------------|
| Live socket message + catch-up replay → duplicate jobs                                               | In-flight claim race                                                                        | #245 / #124   |
| Catch-up dropped mention on conversations.replies failure                                            | Mention not retained for retry                                                              | #243          |
| Job continued after user deleted the source message                                                  | No deletion-cancellation path                                                               | #304          |
| Launchpad requests stranded in CLAIMED/QUEUED across sidecar restarts                                | No reconciliation on boot                                                                   | #249 / #283 / #293 |
| `/wt` slash commands stripped their namespace                                                        | Slash parser miss                                                                           | #247          |

### 3.9 State / persistence / cross-cutting

| Symptom                                                                                              | Root cause                                                                                  | Fix PR        |
|------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|---------------|
| `jobs.workflow` overwritten on resume — couldn't tell what actually ran                              | Single column for both intent + executed                                                    | #281 / #295   |
| CANCELLED collapsed to FAILED in UI                                                                  | Status enum coercion                                                                        | #282 / #289   |
| Failure Doctor diagnosis posted into Slack thread (noise)                                            | Cross-talk into channel; should be desktop-only                                             | #273          |
| Fresh installs couldn't read settings                                                                | Missing migration                                                                           | #279 / #290   |
| Group cache wiped on transient refresh failure → falsely denied access                               | No last-known-good retention                                                                | #241          |

---

## 4. Cross-cutting failure categories — the architectural buckets

When you collapse the 50+ fixes above by *shape* (not by intent), they fall into eight buckets. These are the patterns the redesign has to fix once, instead of fixing per-flow forever.

### A. **Classifier wrong → wrong workflow**
Examples: #302 (low-confidence override drops access), #280/#292 (classifier failure → UNKNOWN instead of best-effort), #299 (tagged-yes reclassified to CONVERSATIONAL), #270 (repo classifier needed LLM). Every flow has paid for this at least once.

### B. **Wrapper makes a decision the LLM should have made**
The signature failure mode of this codebase. Examples: deploy no-op while pending (today), empty-diff "no findings = approved" (#285), wrong-repo worktree (#122), unconditional REQUEST_CHANGES on stylistic findings (#193), inline comments not validated against hunks (#143). The agent had the context to catch each of these and wasn't asked.

### C. **State stitching across turns is brittle**
Investigation → implementation handoff is the canonical case: PRs #299, #300, #301, #302 are all band-aids on the seam between "agent says it found X" and "user confirms, run Y". Same shape in pause/resume (#222/#224/#227) and replan (#205/#206). Root cause: one-shot agent invocations + no per-thread agent memory → state lives in TS tables instead of the agent's head.

### D. **Schema-constrained outputs strip nuance**
Coder JSON self-reports unreliable (#133 — verified against git instead). Planner JSON parse failures silently re-posted old plan (#205/#206). PR review findings forced into a finding-shape lose context. Whenever we constrain the agent's output to a TS-friendly schema, we lose the agent's reasoning about edge cases.

### E. **Trust the wrong source**
Coder self-report (#133), classifier confidence (#302), Failure Doctor surfaced too eagerly (#273), access cache wiped on transient (#241). Wrapper code keeps believing the wrong signal.

### F. **Timeouts kill in-progress agentic work**
Per-agent planner timeout (#306) — model needed more think time than TS thought reasonable. AbortSignal not threaded (#251) — opposite failure: when we *did* want to cancel, we couldn't. We don't have a coherent model of "how long should the agent get."

### G. **Idempotency / duplicate execution**
Deploy retry on Slack post failure (#287/#294). Duplicate jobs from live + catch-up (#245/#124). Stranded launchpad requests (#283). Every retry/recovery seam is a potential double-execution.

### H. **Wrong/missing repo or context**
#122, #129, #270, #307, #308 — the agent operates on the wrong repo because the resolver guessed wrong. #279/#290 — fresh installs couldn't even read settings. The agent's "where am I" is wrapper-decided and easy to get wrong.

---

## 5. Where the architecture pushes back the hardest

Two observations to take into the redesign:

1. **Every category above has the same shape**: TS code makes a decision that strips the agent's ability to course-correct. Bucket A decides routing before the agent sees the request. Bucket B decides outcomes the agent could judge. Bucket C decides handoff protocol in tables instead of in conversation. Bucket D decides output shape. Bucket E decides what signals matter. Bucket F decides time budget. Bucket G decides retry semantics. Bucket H decides location.

2. **The recurring fix shape is "move the decision later / closer to the agent"**: #270 replaced keyword repo classifier with LLM. #299–#302 added LLM-aware gates around the classifier. #306 removed the TS-imposed timeout. #133 verified coder against git instead of JSON. **Every one of these PRs is the wrapper handing back a decision it shouldn't have made.** The redesign is just doing that systematically.

---

## 6. Open questions (for next iteration of this doc)

- Are there flows missing from §2? (I haven't audited `OWNER_AUTOPILOT` vs `IMPLEMENTATION` deeply.)
- Is the bucket framing in §4 the right factoring, or should we split (e.g. "classifier-driven" vs "wrapper-driven" vs "handoff-driven")?
- Which bucket is hurting users *most* right now? Frequency vs severity table?
- For each bucket, what's the smallest experiment that proves the redesign works? (E.g. "rewrite DEPLOY as an agent-owned tool surface, A/B against current.")
