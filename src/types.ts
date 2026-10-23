export type AppView =
  | 'overview'
  | 'launchpad'
  | 'runs'
  | 'intelligence'
  | 'performance'
  | 'dossiers'
  | 'diagnostics'
  | 'settings'
  | 'review';

export type DossierRole = 'pm' | 'dev' | 'designer' | 'ops' | 'analyst';

export type DossierForgetField = 'role' | 'tone' | 'notes' | 'project_affinity' | 'metrics' | 'all';

export type DossierSummary = {
  userId: string;
  displayName: string | null;
  realName: string | null;
  role: DossierRole | null;
  tz: string | null;
  updatedAt: string;
};

export type DossierAffinityRow = {
  repo: string;
  hits: number;
  successes: number;
  failures: number;
  lastUsedAt: string | null;
  computedAt: string;
};

export type DossierMetricRow = {
  metricKey: string;
  metricValue: string;
  computedAt: string;
};

export type DossierDetail = {
  userId: string;
  displayName: string | null;
  realName: string | null;
  tz: string | null;
  email: string | null;
  role: DossierRole | null;
  notes: string | null;
  source: string | null;
  firstSeenAt: string | null;
  updatedAt: string | null;
  tone: string | null;
  toneSource: string | null;
  affinity: DossierAffinityRow[];
  metrics: DossierMetricRow[];
};

export type PinnedFact = {
  id: number;
  userId: string;
  text: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type UserMemory = {
  id: number;
  userId: string;
  jobId: string | null;
  workflow: string | null;
  status: string | null;
  repo: string | null;
  prUrl: string | null;
  product: string | null;
  summary: string;
  createdAt: string;
};

export type SlackCommandTarget = 'miniog' | 'watchtower';

export type ThemePresetId = 'watchtower-midnight' | 'signal-paper' | 'ember-terminal' | 'harbor-mint' | 'custom';

export type ThemeFontFamilyId =
  | 'inter'
  | 'jetbrains-mono'
  | 'system-ui'
  | 'ibm-plex'
  | 'sf-pro'
  | 'avenir-next'
  | 'georgia'
  | 'menlo';

export type NotificationAudioMode = 'off' | 'default' | 'custom';

export type NotificationAudioTone = 'success' | 'failure';

export type NotificationAudioDefaultSoundId =
  | 'basso'
  | 'glass'
  | 'hero'
  | 'ping'
  | 'pop'
  | 'purr'
  | 'sosumi'
  | 'submarine'
  | 'tink';

export type RunSummary = {
  id: string;
  workflow: string;
  status: string;
  taskSummary: string;
  channelId: string;
  threadTs: string;
  createdAt: string;
  updatedAt: string;
  errorMessage: string | null;
};

export type DashboardMetrics = {
  runs24h: number;
  successRate24h: number;
  failedRuns24h: number;
  avgResolutionSeconds24h: number;
  unknownTasks24h: number;
  catchupRecovered24h: number;
  accessAuditWouldDeny24h: number;
  successStreak: number;
  chaosIndex: number;
  cost24hUsd: number;
  tokensInput24h: number;
  tokensOutput24h: number;
  cacheReadTokens24h: number;
  cacheHitRate24h: number;
  avgCostPerRunUsd: number;
};

export type AgentCallRow = {
  id: number;
  jobId: string;
  pipelineRunId: string | null;
  role: string | null;
  backend: string;
  model: string | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costUsd: number | null;
  costSource: string | null;
  ok: boolean;
  createdAt: string;
};

export type SlackUser = {
  name: string;
  avatarUrl: string | null;
  isBot: boolean;
};

export type SlackReaction = {
  name: string;
  count: number;
  users: string[];
};

export type SlackFile = {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  permalink?: string;
  url_private?: string;
  thumb_360?: string;
  thumb_480?: string;
  thumb_720?: string;
  thumb_360_w?: number;
  thumb_360_h?: number;
};

export type DirectoryPerson = {
  id: string;
  name: string;
  realName: string | null;
  avatarUrl: string | null;
};

export type DirectoryGroup = {
  id: string;
  handle: string;
  name: string;
};

/** The workspace's people and user groups, for @mention suggestions. */
export type SlackDirectory = {
  people: DirectoryPerson[];
  groups: DirectoryGroup[];
};

/** What the run's thread view can do with the run itself. */
export type RunControls = {
  canStop: boolean;
  /** What a re-run would ask, without the mention of miniOG. */
  rerunAsk: string | null;
  /** Who a re-run is for, when that isn't the owner. */
  rerunFor: string | null;
  /** The run working in this thread now, if any. */
  busyJobId: string | null;
  /** That run is waiting for an answer, which a new ask would be taken as. */
  busyWaiting: boolean;
  /** A run started from the app that miniOG hasn't picked up yet. */
  starting: boolean;
  /** The run waiting for an answer in this thread, when one is. */
  answer: AnswerTarget | null;
};

/** What a waiting run waits for: a gate mid-run, or "paused" once it stopped to wait. */
export type AnswerKind = 'approval' | 'question' | 'repo_choice' | 'confirm' | 'paused';

export type AnswerTarget = {
  /** This run or another in the thread. */
  jobId: string;
  kind: AnswerKind;
  /** The question it waits on, when it waits mid-run. */
  promptTs: string | null;
  /** Who it takes an answer from, when the owner isn't one of them. */
  answerBy: string[];
  /** The exact phrase a confirm takes, when it takes nothing else. */
  expects: string | null;
};

export type StartedRun = {
  requestId: string;
  askTs: string | null;
  /** For an answer: the run it answers. */
  answersJobId: string | null;
};

/** A run started from the thread view, as its launchpad request tracks it. */
export type StartedRunStatus = { status: string; jobId: string | null; error: string | null };

/** A Slack message object as conversations.replies returns it (the fields the app reads). */
export type SlackMessage = {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  bot_profile?: { name?: string; icons?: { image_48?: string; image_72?: string } };
  username?: string;
  text?: string;
  subtype?: string;
  edited?: { ts: string };
  reactions?: SlackReaction[];
  files?: SlackFile[];
  blocks?: { type: string }[];
};

export type RunThread = {
  hasThread: boolean;
  channelId: string;
  channelName: string | null;
  channelKind: 'channel' | 'private' | 'im' | 'mpim' | '';
  threadTs: string;
  /** The message that started this run, when it came from one. */
  triggerTs: string | null;
  botUserId: string;
  permalink: string | null;
  messages: SlackMessage[];
  /** Replies per Slack; can exceed what `messages` holds. */
  replyCount: number;
  /** True when the thread is longer than the app reads. */
  truncated: boolean;
  users: Record<string, SlackUser>;
  /** Set when the app could not read the thread. */
  readError: SlackReadError | null;
};

export type SlackReadError = {
  /** noAccess: a private channel the bot can't read, though it can still remove its emojis. */
  kind: 'deleted' | 'auth' | 'noAccess' | 'other';
  code: string;
};

export type RemoveReactionsResult = {
  removed: string[];
  failed: string[];
};

export type JobCostSummary = {
  jobId: string;
  totalCostUsd: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  callCount: number;
  calls: AgentCallRow[];
};

export type GroupedAggregate = {
  key: string;
  calls: number;
  totalCostUsd: number;
  totalDurationMs: number;
  avgCostUsd: number;
  avgDurationMs: number;
};

export type TopRun = {
  jobId: string;
  workflow: string;
  status: string;
  startedAt: string;
  durationMs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  callCount: number;
};

export type PerformanceOverview = {
  sinceIso: string;
  untilIso: string;
  totalCostUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  cacheHitRate: number;
  avgCostPerRunUsd: number;
  byWorkflow: GroupedAggregate[];
  byBackendModel: GroupedAggregate[];
  topRuns: TopRun[];
};

export type DashboardRecommendation = {
  id: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW' | string;
  title: string;
  detail: string;
};

export type ChannelHeat = {
  channelId: string;
  runs: number;
  failures: number;
};

export type PersonalityModeStats = {
  mode: string;
  count: number;
};

export type LearningInsights = {
  signals24h: number;
  correctionsLearned: number;
  correctionsApplied24h: number;
  personalityProfiles: number;
  dominantPersonalityMode: string;
  topFailureKind: string;
  topFailureCount: number;
  profilesByMode: PersonalityModeStats[];
};

export type DashboardData = {
  sidecarStatus: string;
  settingsConfigured: boolean;
  activeJobs: RunSummary[];
  recentRuns: RunSummary[];
  failures: RunSummary[];
  metrics: DashboardMetrics;
  learning: LearningInsights;
  recommendations: DashboardRecommendation[];
  channelHeat: ChannelHeat[];
};

export type JobLogEntry = {
  id: number;
  jobId: string;
  level: 'INFO' | 'WARN' | 'ERROR' | string;
  stage: string;
  message: string;
  dataJson: string | null;
  createdAt: string;
};

export type AgentBackendId = 'codex' | 'claude-code';

export type AccessMode = 'audit' | 'enforce';

export type AccessGroupKey = 'viewer' | 'reviewer' | 'builder' | 'admin' | 'owner';

export type AccessGroupSettings = {
  manualUserIds: string;
  allowedChannelIds: string;
  allowIm: boolean;
  allowMpim: boolean;
};

export type AccessControlSettings = {
  mode: AccessMode;
  groups: Record<AccessGroupKey, AccessGroupSettings>;
};

/**
 * Capability bundles (replaces the legacy 5-tier `AccessGroupSettings`).
 * Mirrors the sidecar `Bundle` shape in `sidecar/src/types/contracts.ts`
 * and the Rust `BundleRecord` exposed via the Tauri IPC commands
 * `get_bundles` / `save_bundle` / `delete_bundle`.
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
  | 'manage_access';

export type Bundle = {
  name: string;
  /** The people on the bundle, as comma-separated Slack user IDs. */
  manualUserIds: string;
  resolvedUserIds: string[];
  capabilities: Capability[];
  allowedChannelIds: string[];
  allowIm: boolean;
  allowMpim: boolean;
};

export type AppSettings = {
  slackBotToken: string;
  slackAppToken: string;
  ownerSlackUserIds: string;
  botUserId: string;
  bugsAndUpdatesChannelId: string;
  newtonWebPath: string;
  newtonApiPath: string;
  newtonMarketingWebPath: string;
  maxConcurrentJobs: number;
  repoClassifierThreshold: number;
  themePreset: ThemePresetId;
  themeBackgroundColor: string;
  themeForegroundColor: string;
  themeAccentColor: string;
  themeFontFamily: ThemeFontFamilyId;
  successNotificationAudioMode: NotificationAudioMode;
  successNotificationAudioDefaultSound: NotificationAudioDefaultSoundId;
  successNotificationAudioCustomPath: string;
  failureNotificationAudioMode: NotificationAudioMode;
  failureNotificationAudioDefaultSound: NotificationAudioDefaultSoundId;
  failureNotificationAudioCustomPath: string;
  agentBackend: AgentBackendId;
  coreDevSlackUserIds: string;
  vaultPath: string;
  vaultEnabled: boolean;
  accessControl: AccessControlSettings;
};

export type SaveSettingsResponse = {
  configured: boolean;
};

export type ImportNotificationAudioResponse = {
  fileName: string;
  path: string;
};

export type LaunchpadSubmitResponse = {
  requestId: string;
};

export type AppNotificationPayload = {
  title: string;
  body: string;
  tone: NotificationAudioTone;
};

export type DiffFileEntry = {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  insertions: number;
  deletions: number;
};

export type JobDiff = {
  jobId: string;
  branchName: string;
  repoPath: string;
  diffText: string;
  files: DiffFileEntry[];
  insertions: number;
  deletions: number;
};

export type CreatePrRequest = {
  jobId: string;
  title: string;
  body: string;
};

export type CreatePrResponse = {
  prUrl: string;
};

export type PipelineRunData = {
  id: string;
  jobId: string;
  status: string;
  steps: Array<{
    role: string;
    status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
    durationMs: number;
    findings: Array<{
      severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
      category: string;
      message: string;
      file?: string;
      line?: number;
      suggestion?: string;
    }>;
  }>;
  retryLoops: number;
  totalDurationMs: number | null;
};
