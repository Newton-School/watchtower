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
  slackUserGroupHandle: string;
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
  slackUserGroupHandle: string;
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
  coreDevSlackUserGroup: string;
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
