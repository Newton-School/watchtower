import type { RepoKey } from '../repos/registry.js';

export type AgentBackendId = 'codex' | 'claude-code';
export type AccessMode = 'audit' | 'enforce';
/**
 * @deprecated The strict 5-tier hierarchy is being replaced by capability bundles
 * (see `Capability` + `Bundle` below). Existing callers keep working via the
 * `evaluateAccess` → `evaluateCapability` adapter; this type will be removed
 * once the router-driven dispatcher is replaced by the agent-owned dispatcher.
 */
export type AccessGroupKey = 'viewer' | 'reviewer' | 'builder' | 'admin' | 'owner';
/** @deprecated Alias of AccessGroupKey. See deprecation note on AccessGroupKey. */
export type AccessLevel = AccessGroupKey;

/**
 * Fixed (but extensible) set of operations the agent can perform. Access
 * decisions gate on these directly rather than on a workflow intent, so the
 * model survives the upcoming agent-owned arch where there is no fixed
 * `WorkflowIntent` enum. Add new capabilities here as new tools land.
 */
export type Capability =
  | 'query_codebase'
  | 'chat'
  | 'submit_pr_review'
  | 'comment_pr'
  | 'start_implementation'
  | 'investigate'
  | 'deploy_prod'
  | 'dev_assist'
  | 'miniog_dossier_self'
  | 'miniog_dossier_admin'
  // Owner-only — the "manage the access-control system itself" capability.
  // Preserves the legacy `requiredLevel: 'owner'` semantics through the
  // capability wrapper (without it, admin and owner share identical
  // capability sets and the wrapper can't distinguish them).
  | 'manage_access';

/**
 * A named set of capabilities given to the people listed on it. Bundles
 * are peers (no hierarchy) — a user is granted the union of capabilities
 * across every bundle they belong to.
 *
 * Channel scope is per-bundle to preserve the exact `evaluateAccess`
 * semantics in the legacy `AccessControlConfig` (each tier had its own
 * `allowedChannelIds`). The forward-facing global `ChannelAcl` model lands
 * when the legacy types are removed (D6).
 */
export interface Bundle {
  name: string;
  /** The people on this bundle, as comma-separated Slack user IDs. */
  manualUserIds: string;
  /**
   * `manualUserIds` parsed, plus the owners on the admin and owner bundles
   * (`hydrateBundleUserIds`).
   */
  resolvedUserIds: string[];
  capabilities: Capability[];
  allowedChannelIds: string[];
  allowIm: boolean;
  allowMpim: boolean;
}

/**
 * Channel-scoping for the bot as a whole, orthogonal to capability grants.
 * If a user has a capability, they can use it in any channel listed here
 * (or in IM/MPIM when the corresponding flag is set). Replaces the per-group
 * channel allowlists in the legacy `AccessControlConfig` shape.
 */
export interface ChannelAcl {
  enabledChannelIds: string[];
  enabledInIm: boolean;
  enabledInMpim: boolean;
}

export type WorkflowIntent =
  | 'PR_REVIEW'
  | 'OWNER_AUTOPILOT'
  | 'IMPLEMENTATION'
  | 'INVESTIGATION'
  | 'INFORMATIONAL'
  | 'CONVERSATIONAL'
  | 'NONE'
  | 'DEV_ASSIST'
  | 'DEPLOY'
  | 'STAGING_DEPLOY'
  | 'MINIOG_DOSSIER'
  | 'WEBAPP_QA'
  | 'UNKNOWN';
export type WorkflowStatus = 'SUCCESS' | 'FAILED' | 'PAUSED' | 'SKIPPED' | 'CANCELLED';
export type JobLogLevel = 'INFO' | 'WARN' | 'ERROR';
export type PersonalityMode = 'normal' | 'terse' | 'technical' | 'casual';

export type DossierRole = 'pm' | 'dev' | 'designer' | 'ops' | 'analyst';
export type DossierForgetField = 'role' | 'tone' | 'notes' | 'project_affinity' | 'metrics' | 'all';

export type MiniogSubcommand =
  | { kind: 'whoami' }
  | { kind: 'set-role'; role: DossierRole }
  | { kind: 'forget'; field: DossierForgetField; confirmed: boolean }
  | { kind: 'remember'; text: string }
  | { kind: 'memories' }
  | { kind: 'forget-memory'; id: number }
  | { kind: 'forget-thread'; confirmed: boolean }
  | { kind: 'handoff'; format: 'auto' | 'paste' | 'file' | 'link' };
export type EventIngestSource = 'socket' | 'catchup' | 'launchpad';
export type LaunchpadTarget = 'miniog';
export type LaunchpadRequestStatus =
  | 'PENDING'
  | 'CLAIMED'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'PAUSED'
  | 'SKIPPED';

export interface AccessGroupSettings {
  manualUserIds: string;
  allowedChannelIds: string;
  allowIm: boolean;
  allowMpim: boolean;
}

export interface AccessControlSettings {
  mode: AccessMode;
  groups: Record<AccessGroupKey, AccessGroupSettings>;
}

export interface ResolvedAccessGroup extends AccessGroupSettings {
  key: AccessGroupKey;
  resolvedChannelIds: string[];
  resolvedUserIds: string[];
}

export interface AccessControlConfig {
  mode: AccessMode;
  groups: Record<AccessGroupKey, ResolvedAccessGroup>;
}

export interface AppConfig {
  platformPolicy: 'macos_only';
  bundleTargets: Array<'app' | 'dmg'>;
  ownerSlackUserIds: string[];
  coreDevSlackUserIds: string[];
  botUserId: string;
  slackBotToken: string;
  slackAppToken: string;
  bugsAndUpdatesChannelId: string;
  allowedChannelsForBugFix: string[];
  repoPaths: {
    newtonWeb: string;
    newtonApi: string;
    /**
     * Optional absolute path to the newton-marketing-web clone (the public
     * newtonschool.co marketing site). Unset means the repo is not onboarded
     * on this host: routing never offers it and marketing-aware features
     * degrade gracefully instead of erroring.
     */
    newtonMarketingWeb?: string;
    /**
     * Optional absolute path to the watchtower repo itself. Powers the
     * self-inquiry target in the informational workflow so miniOG can answer
     * questions about its own configuration. If unset, the workflow attempts
     * to auto-detect via the sidecar's __dirname.
     */
    watchtower?: string;
  };
  /**
   * Absolute directory that miniOG's working clones must live under. Enforced
   * at config load: if `repoPaths.newtonWeb` or `repoPaths.newtonApi` is not
   * under this root, config load fails and implementation work is refused.
   * Keeps the coder agent away from the user's personal clones (which may
   * have arbitrary feature branches checked out). Optional at the type level
   * only so existing test fixtures compile; production AppConfig values
   * always set it via `mapSettingsToConfig`.
   */
  miniOgRepoRoot?: string;
  unknownTaskPolicy: 'desktop_only';
  uncertainRepoPolicy: 'desktop_only';
  unmappedPrRepoPolicy: 'desktop_only';
  maxConcurrentJobs: number;
  repoClassifierThreshold: number;
  allowedPrOrg: string;
  multiAgentEnabled: boolean;
  agentBackend: AgentBackendId;
  prReviewTimeoutMs: number;
  bugFixTimeoutMs: number;
  pmTaskTimeoutMs: number;
  /**
   * HTTP MCP endpoint for the Metabase (read-only DB) server. Used by the
   * broad-scope investigation to inspect the data layer alongside the repos.
   * Empty string disables it (broad mode then runs repos-only). Only the
   * claude-code backend can use it (via --mcp-config); the OAuth token is
   * the headless CLI's Keychain-cached session.
   */
  metabaseMcpUrl: string;
  accessControl?: AccessControlConfig;
  /**
   * Capability-bundles view of access control. Derived from `accessControl`
   * at config load (D3) and consumed by `evaluateCapability`. Always
   * populated when `accessControl` is. Channel scoping lives per-bundle for
   * legacy parity; `ChannelAcl` becomes the source of truth in D6 alongside
   * the legacy removal.
   */
  bundles?: Bundle[];
}

/** What a gate waiting on a person mid-run asked for. */
export type HumanWaitKind = 'approval' | 'question' | 'repo_choice' | 'confirm';

/**
 * A gate waiting on a person while its job runs. Kept in `human_waits` for
 * the length of the wait, so the app can show the run waits and answer it.
 */
export interface HumanWait {
  jobId: string;
  kind: HumanWaitKind;
  channelId: string;
  threadTs: string;
  /** The question the gate posted; only replies after it count. */
  promptTs: string;
  /** Who the gate takes an answer from. Empty when it is not a fixed list of people. */
  allowedUserIds: string[];
  /** The exact phrase a confirm gate takes, when it takes nothing else. */
  expects?: string;
  startedAt: string;
}

export interface SlackEventEnvelope {
  eventId: string;
  channelId: string;
  channelType?: string;
  responseUrl?: string;
  threadTs: string;
  eventTs: string;
  userId: string;
  text: string;
  messageSubtype?: string;
  ingestSource?: EventIngestSource;
  launchpadRequestId?: string;
  /**
   * On-behalf-of user for launchpad retriggers (issue #343): the person whose
   * request this really is. Attribution (PR title/body, dossier recall) uses
   * this; permissions still evaluate `userId` (the owner who retriggered).
   */
  requestedForUserId?: string;
  /**
   * The paused job an answer from the app picks up again. Whatever the answer
   * says, it is the reply that job waits for.
   */
  answersJobId?: string;
  /**
   * For `message_deleted` subtypes: the ts of the message that was deleted
   * (Slack puts the deletion event itself in `event.ts`, and the original
   * message's ts in `event.deleted_ts` / `event.previous_message.ts`).
   * Populated only by `normalizeEnvelope` when subtype === 'message_deleted'.
   */
  deletedTs?: string;
  /**
   * For `message_deleted` subtypes: a snapshot of the deleted message so
   * downstream handlers can identify which job to cancel without doing an
   * extra API round-trip. The author and thread context come from the
   * deletion event's `previous_message` block.
   */
  previousMessage?: {
    ts: string;
    userId: string;
    threadTs?: string;
    text?: string;
  };
  rawEvent: Record<string, unknown>;
}

export interface LaunchpadRequestRecord {
  id: string;
  target: LaunchpadTarget;
  prompt: string;
  ownerUserId: string;
  status: LaunchpadRequestStatus;
  jobId?: string;
  slackChannelId?: string;
  anchorTs?: string;
  /**
   * On-behalf-of user (issue #343). Drives PR attribution and dossier recall;
   * access control still evaluates ownerUserId. Optional — owner-only
   * requests behave exactly as before.
   */
  requestedForUserId?: string;
  /**
   * When set (with originThreadTs), the synthetic event anchors in this
   * channel/thread instead of the owner DM, so progress, approvals, and the
   * PR link land where the original request lives.
   */
  originChannelId?: string;
  originThreadTs?: string;
  /**
   * The message in the origin thread the run starts from, which gets its
   * emojis: a posted ask, or the message a re-run repeats. The thread's first
   * message when unset.
   */
  originEventTs?: string;
  /**
   * Not a new run but the owner's answer, from the app's thread view, to this
   * run waiting on a person; the prompt is the answer. A run paused on its
   * question is picked up again with it, and a gate waiting mid-run takes it
   * as the owner's reply.
   */
  answerForJobId?: string;
  /** The question the answer was written for, when the run waits mid-run. */
  answerPromptTs?: string;
  resultJson?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SlackReactionEvent {
  eventId: string;
  channelId: string;
  threadTs: string;
  eventTs: string;
  userId: string;
  reaction: string;
  itemUserId?: string;
  rawEvent: Record<string, unknown>;
}

export interface PrContext {
  url: string;
  owner: string;
  repo: string;
  number: number;
}

/**
 * A PR mentioned somewhere in the request. `source` records whether the URL
 * was in the trigger message itself or elsewhere in the thread — trigger
 * URLs outrank thread URLs during review-target resolution.
 */
export interface PrTarget extends PrContext {
  source: 'trigger' | 'thread';
}

/**
 * One Slack thread message as fetched at intake. Structurally identical to
 * `ThreadMessage` in slack/threadContext.ts — declared here so NormalizedTask
 * can carry the intake-fetched thread without contracts importing from the
 * slack layer.
 */
export interface NormalizedThreadMessage {
  text: string;
  user: string;
  ts: string;
  /** Slack message subtype (e.g. 'bot_message'), when present. */
  subtype?: string;
  /** Slack bot_id for integration-posted messages, when present. */
  botId?: string;
  files?: Array<{ id: string; name: string; mimetype: string; url_private_download: string }>;
}

export interface NormalizedTask {
  event: SlackEventEnvelope;
  mentionDetected: boolean;
  mentionType: 'bot' | 'owner' | 'none';
  /**
   * The bot is mentioned only in passing ("@miniOG's comments", "cc: @miniOG"):
   * the message may be about it or addressed to someone else (issue #448).
   */
  mentionReference?: boolean;
  isOwnerAuthor: boolean;
  isCoreDevAuthor: boolean;
  intent: WorkflowIntent;
  /** First PR found (trigger-ranked) — back-compat single-PR view of `prContexts`. */
  prContext?: PrContext;
  /** Every distinct PR URL in the trigger + thread, trigger URLs first. */
  prContexts?: PrTarget[];
  /**
   * Thread messages fetched once at intake (index.ts) — the same fetch that
   * feeds threadTexts into normalizeTask. Carried on the task so downstream
   * consumers (agentic entry, intent classifier, conversation capture) reuse
   * it instead of re-fetching from Slack.
   */
  threadMessages?: NormalizedThreadMessage[];
  miniogSubcommand?: MiniogSubcommand;
  /**
   * Dossier-derived tone preference, populated by the router after looking up
   * the requesting user's personality_profiles row. Defaults to 'normal' when
   * no per-user override is set; downstream prompts honor this.
   */
  toneMode?: PersonalityMode;
  /**
   * Asker's dossier role, populated by the router. Conversational prompts
   * adapt their explanation depth and code-snippet density based on this
   * (non-dev roles get plain-language, low-code answers).
   */
  dossierRole?: DossierRole;
  /**
   * Set when this message is the requester's reply to a question miniOG asked
   * about an earlier message it could not act on (issue #431).
   */
  clarification?: { question: string; askedText: string };
  /**
   * Set only by the router's PR-action gate (issue #719): the message is one of
   * the gate's exact sentences, addressed to miniOG. The change workflow runs
   * this operation without a planner, and the owner's own ask unconfirmed; no
   * other task does.
   */
  prActionGate?: {
    action: 'merge' | 'close' | 'sync';
    pr: PrContext;
    /** "merge it into master": only when that is the PR's base branch. */
    intoBase?: 'master' | 'main';
  };
  /**
   * This message resumed a paused job (a usage-limit "go ahead", a PR link
   * miniOG asked for, an answer to its question). Only an answer to miniOG's
   * own question (`clarification`) may open the PR-action gate (issue #719).
   */
  resumedPausedJob?: boolean;
  /**
   * Set by the router when this request runs on an owner's authority: the
   * requester tagged the owner and fails their own access check (issue #398).
   * Only permission checks read it; the requester stays who the work is for.
   */
  delegatedByOwnerId?: string;
  /**
   * Set at intake when this message answers a question miniOG asked on a
   * delegated request: the answer is checked on the same owner's authority.
   */
  inheritedDelegationOwnerId?: string;
}

export interface RepoClassificationResult {
  selectedRepo: RepoKey | null;
  confidence: number;
  reasoning: string;
  uncertain: boolean;
}

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface CodexRunRequest {
  cwd: string;
  prompt: string;
  timeoutMs?: number;
  outputSchemaPath?: string;
  githubToken?: string;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  imagePaths?: string[];
  onLog?: WorkflowStepLogger;
  signal?: AbortSignal;
  /** Start a new Claude Code session with this ID. */
  sessionId?: string;
  /** Resume an existing Claude Code session (sends prompt as follow-up). */
  resumeSessionId?: string;
  /**
   * Run the backend in plan mode. Only honored by the claude-code backend
   * (adds `--permission-mode plan`). The Codex backend ignores this.
   */
  planMode?: boolean;
  /**
   * MCP servers to expose to the agent for this run. Only honored by the
   * claude-code backend, where a run that uses tools always gets
   * `--mcp-config <inline JSON>` + `--strict-mcp-config`, so ONLY these servers
   * load and none of the host user's (issue #443). Left unset, the run takes
   * the list its workflow set with `withConnectors`, which is empty by
   * default. HTTP/OAuth servers reuse the headless CLI's Keychain-cached token
   * (requires HOME in the spawn env). The Codex backend ignores this.
   */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Tool rules the run may not use, on top of the ones every run gets. Only
   * honored by the claude-code backend (`--disallowedTools`), where deny rules
   * hold even when permissions are bypassed.
   */
  disallowedTools?: string[];
  /**
   * Force a specific backend for this run, overriding the global active
   * backend. Used by the webapp-QA flow, which must run on `claude-code`
   * (native Bash to drive Playwright + image support) regardless of the
   * deployed default. `runCodex` resolves `backendOverride ?? activeBackendId`.
   */
  backendOverride?: AgentBackendId;
  /**
   * The call only has to turn text into text: a classification, a summary.
   * On the claude-code backend it then gets no built-in tools, no MCP
   * servers, no skills, no hooks and no bypassed permissions (issue #443).
   * Such calls read arbitrary Slack text, and used to run with every tool and
   * every connector the host user has. The Codex backend ignores this; it
   * runs sandboxed.
   */
  noTools?: boolean;
  /**
   * The run only reads: a lookup, a chat reply, an investigation (issue
   * #443). On the claude-code backend it runs in `dontAsk` mode with an
   * allow-list (`READ_ONLY_ALLOW_RULES`) instead of bypassed permissions:
   * anything not allowed is refused, with no prompt. The Codex backend
   * ignores this: `--full-auto` already confines writes to its cwd and /tmp,
   * and a read-only sandbox would refuse the reply's attachments too.
   */
  readOnly?: boolean;
  /**
   * Run the agent's shell commands in Claude Code's sandbox (issue #445).
   * On by default for every run with tools on the claude-code backend; set
   * false only for runs the sandbox breaks (browser QA, deploys). See
   * `agentSandbox.ts`. The Codex backend ignores this.
   */
  sandbox?: boolean;
}

export type McpServerConfig =
  | { type: 'http'; url: string }
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> };

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type CostSource = 'reported' | 'computed';

export interface CodexRunResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  cancelled?: boolean;
  stdout: string;
  stderr: string;
  lastMessage: string;
  parsedJson?: Record<string, unknown>;
  /**
   * Set when a failed run is classified as a known retryable condition.
   * USAGE_LIMIT = the CLI hit the account's session/usage cap before any
   * API tokens were consumed (issue #342) — callers should pause/retry at
   * the reset time instead of treating the output as an agent verdict.
   */
  errorKind?: 'USAGE_LIMIT' | 'API_ERROR' | 'EXTERNAL_KILL';
  /** Verbatim reset clause from the limit message, e.g. "9:40pm (Asia/Calcutta)". */
  limitResetsAtText?: string;
  /**
   * For EXTERNAL_KILL: the signal that ended the process, when the OS reported
   * one. The run was stopped from outside (not by a timeout or a cancel), so
   * its exit is not a verdict on the work (issue #445).
   */
  killSignal?: string;
  /**
   * For API_ERROR: the CLI's own error line ("API Error: Can't reach the API
   * server …"). The run died on the connection, so nothing in it is the
   * agent's output and `ok` is false whatever the exit code (issue #439).
   */
  apiErrorDetail?: string;
  /** Wall-clock duration from process spawn to exit, in milliseconds. */
  durationMs: number;
  /** Token usage extracted from backend output, when available. */
  usage?: TokenUsage;
  /** Cost in USD: backend-reported when available, otherwise computed from price table. */
  costUsd?: number;
  /** Provenance of `costUsd` so callers can distinguish authoritative vs estimated costs. */
  costSource?: CostSource;
  /** Backend that produced this result. */
  backend: AgentBackendId;
  /** Model identifier used (request.model when set, otherwise backend default). */
  modelUsed?: string;
  /** Session ID returned by Claude Code, usable for session resumption. */
  sessionId?: string;
}

export interface AgentCallRecord {
  id?: number;
  jobId: string;
  pipelineRunId?: string;
  role?: string;
  backend: AgentBackendId;
  model?: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  costSource?: CostSource;
  ok: boolean;
  createdAt: string;
}

export interface JobCostSummary {
  jobId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  callCount: number;
  calls: AgentCallRecord[];
}

export interface CallSummarySince {
  totalCostUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  cacheHitRate: number;
}

export interface WorkflowResult {
  status: WorkflowStatus;
  workflow: WorkflowIntent;
  message: string;
  notifyDesktop: boolean;
  slackPosted: boolean;
  result?: Record<string, unknown>;
  /**
   * Set when status === 'PAUSED' to capture the workflow's wait-stage state so a
   * later @miniOG mention in the same thread can resume execution at the same
   * point. Persisted into jobs.result_json by the dispatcher and reloaded on resume.
   */
  resumeContext?: ResumeContext;
}

/**
 * Implementation workflow paused at the plan-approval gate, waiting for either
 * an approve/reject/feedback from anyone in the thread OR a "wait" + later @-mention to resume.
 */
export interface ImplementationApprovalResume {
  workflow: 'IMPLEMENTATION' | 'OWNER_AUTOPILOT';
  stage: 'awaiting_approval';
  iteration: number;
  feedbackRounds: number;
  planMarkdown: string;
  planAffectedFiles: string[];
  planScope: string;
  plannerSessionId?: string;
  plannerOutput?: Record<string, unknown>;
  planMessageTs?: string;
  approvalPromptTs?: string;
  pipelineCwd: string;
  pauseCount: number;
}

/** Implementation workflow paused after a reject prompt asking "want to revise?". */
export interface ImplementationRevisionChoiceResume {
  workflow: 'IMPLEMENTATION' | 'OWNER_AUTOPILOT';
  stage: 'awaiting_revision_choice';
  iteration: number;
  feedbackRounds: number;
  planMarkdown: string;
  planAffectedFiles: string[];
  planScope: string;
  plannerSessionId?: string;
  plannerOutput?: Record<string, unknown>;
  planMessageTs?: string;
  askReviseTs?: string;
  pipelineCwd: string;
  pauseCount: number;
}

/** Implementation workflow paused at the repo-choice clarification gate. */
export interface ImplementationRepoChoiceResume {
  workflow: 'IMPLEMENTATION' | 'OWNER_AUTOPILOT';
  stage: 'awaiting_repo_choice';
  promptTs?: string;
  pauseCount: number;
}

export type ResumeContext =
  | ImplementationApprovalResume
  | ImplementationRevisionChoiceResume
  | ImplementationRepoChoiceResume;

export interface JobRecord {
  id: string;
  eventId: string;
  dedupeKey: string;
  workflow: WorkflowIntent;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'PAUSED' | 'SKIPPED' | 'CANCELLED';
  channelId: string;
  threadTs: string;
  attempts: number;
  payloadJson?: string;
  resultJson?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStepLog {
  level?: JobLogLevel;
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

export type WorkflowStepLogger = (step: WorkflowStepLog) => void;

export interface JobLogRecord {
  id: number;
  jobId: string;
  level: JobLogLevel;
  stage: string;
  message: string;
  dataJson?: string;
  createdAt: string;
}
