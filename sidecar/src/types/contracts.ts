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
 * A named set of capabilities that can be assigned to users via a Slack
 * subteam handle and/or a comma-delimited list of manual user IDs. Bundles
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
  slackUserGroupHandle: string;
  manualUserIds: string;
  /**
   * Resolved user IDs for this bundle — the union of `manualUserIds`
   * (parsed) and the members of `slackUserGroupHandle` (after Slack subteam
   * expansion, refreshed every 30 min by `setResolvedGroupMembers`).
   * Mutating this in place is the expected hot-reload path for live subteam
   * membership changes.
   */
  resolvedUserIds: string[];
  /**
   * Slack subteam IDs resolved from `slackUserGroupHandle` (refreshed
   * alongside `resolvedUserIds`). Needed because `<!subteam^…>` mentions
   * only accept the ID — a raw handle renders as dead text.
   */
  resolvedSubteamIds?: string[];
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
  | 'MINIOG_DOSSIER'
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
  | { kind: 'forget-memory'; id: number };
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
  slackUserGroupHandle: string;
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
  /** Slack subteam IDs for `slackUserGroupHandle` — see Bundle.resolvedSubteamIds. */
  resolvedSubteamIds?: string[];
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
  coreDevSlackUserGroup: string;
  /**
   * Slack subteam IDs resolved from `coreDevSlackUserGroup` by the 30-min
   * access refresh. Covers legacy installs without an accessControl admin
   * group; `formatAdminMention` falls back to these.
   */
  resolvedCoreDevSubteamIds?: string[];
  botUserId: string;
  slackBotToken: string;
  slackAppToken: string;
  bugsAndUpdatesChannelId: string;
  allowedChannelsForBugFix: string[];
  repoPaths: {
    newtonWeb: string;
    newtonApi: string;
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

export interface NormalizedTask {
  event: SlackEventEnvelope;
  mentionDetected: boolean;
  mentionType: 'bot' | 'owner' | 'none';
  isOwnerAuthor: boolean;
  isCoreDevAuthor: boolean;
  intent: WorkflowIntent;
  /** First PR found (trigger-ranked) — back-compat single-PR view of `prContexts`. */
  prContext?: PrContext;
  /** Every distinct PR URL in the trigger + thread, trigger URLs first. */
  prContexts?: PrTarget[];
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
}

export interface RepoClassificationResult {
  selectedRepo: 'newton-web' | 'newton-api' | null;
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
   * claude-code backend (adds `--mcp-config <inline JSON>` + `--strict-mcp-config`
   * so ONLY these servers load). HTTP/OAuth servers reuse the headless CLI's
   * Keychain-cached token (requires HOME in the spawn env). The Codex backend
   * ignores this. Used by the broad-scope investigation to reach Metabase.
   */
  mcpServers?: Record<string, McpServerConfig>;
}

export interface McpServerConfig {
  type: 'http';
  url: string;
}

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
  errorKind?: 'USAGE_LIMIT';
  /** Verbatim reset clause from the limit message, e.g. "9:40pm (Asia/Calcutta)". */
  limitResetsAtText?: string;
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
 * an admin approve/reject/feedback OR (now) a "wait" + later @-mention to resume.
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
