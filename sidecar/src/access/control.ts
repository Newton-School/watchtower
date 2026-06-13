import type {
  AccessControlConfig,
  AccessControlSettings,
  AccessGroupKey,
  AccessGroupSettings,
  AccessLevel,
  AppConfig,
  Bundle,
  Capability,
  WorkflowIntent,
} from '../types/contracts.js';

/** @deprecated Tier-based hierarchy is being replaced by capability bundles. */
export const ACCESS_GROUP_KEYS: AccessGroupKey[] = ['viewer', 'reviewer', 'builder', 'admin', 'owner'];

/**
 * @deprecated Rank ordering exists only to support the legacy tier model and
 * the classifier confidence floor (`router/taskRouter.ts:142–194`). Capability
 * bundles are peers — no ranking. Remove once `evaluateAccess` is gone.
 */
export const ACCESS_RANK: Record<AccessLevel, number> = {
  viewer: 0,
  reviewer: 1,
  builder: 2,
  admin: 3,
  owner: 4,
};

export type AccessDenyReason = 'NOT_ON_ACCESS_LIST' | 'INSUFFICIENT_ROLE' | 'CHANNEL_NOT_ENABLED';

export type AccessDecision = {
  allowed: boolean;
  ownerBypass: boolean;
  requiredLevel: AccessLevel;
  matchedGroups: AccessGroupKey[];
  userGroups: AccessGroupKey[];
  reason?: string;
  denyReason?: AccessDenyReason;
};

export function createDefaultAccessGroupSettings(): AccessGroupSettings {
  return {
    slackUserGroupHandle: '',
    manualUserIds: '',
    allowedChannelIds: '',
    allowIm: false,
    allowMpim: false,
  };
}

export function createDefaultAccessControlSettings(): AccessControlSettings {
  return {
    mode: 'audit',
    groups: {
      viewer: createDefaultAccessGroupSettings(),
      reviewer: createDefaultAccessGroupSettings(),
      builder: createDefaultAccessGroupSettings(),
      admin: createDefaultAccessGroupSettings(),
      owner: createDefaultAccessGroupSettings(),
    },
  };
}

function uniqueList(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function parseDelimitedIds(raw: string): string[] {
  return uniqueList(
    raw
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
  );
}

function hydrateAccessControlSettings(settings?: Partial<AccessControlSettings> | null): AccessControlSettings {
  const defaults = createDefaultAccessControlSettings();
  const groups = defaults.groups;

  for (const key of ACCESS_GROUP_KEYS) {
    groups[key] = {
      ...defaults.groups[key],
      ...(settings?.groups?.[key] ?? {}),
    };
  }

  return {
    mode: settings?.mode === 'enforce' ? 'enforce' : 'audit',
    groups,
  };
}

function toResolvedAccessGroup(key: AccessGroupKey, group: AccessGroupSettings, ownerSlackUserIds: string[]) {
  const manualUserIds = parseDelimitedIds(group.manualUserIds);
  const includesOwners = key === 'admin' || key === 'owner';

  return {
    key,
    ...group,
    resolvedChannelIds: parseDelimitedIds(group.allowedChannelIds),
    resolvedUserIds: includesOwners ? uniqueList([...ownerSlackUserIds, ...manualUserIds]) : manualUserIds,
  };
}

export function buildLegacyAccessControlConfig(input: {
  ownerSlackUserIds: string[];
  coreDevSlackUserIds?: string[];
  coreDevSlackUserGroup?: string;
  allowedChannelsForBugFix?: string[];
}): AccessControlConfig {
  const defaults = hydrateAccessControlSettings();
  const bugFixChannels = uniqueList(input.allowedChannelsForBugFix ?? []);
  defaults.groups.builder.allowedChannelIds = bugFixChannels.join(',');
  defaults.groups.admin.allowedChannelIds = bugFixChannels.join(',');
  defaults.groups.admin.allowIm = true;
  defaults.groups.admin.allowMpim = true;
  defaults.groups.admin.manualUserIds = uniqueList(input.coreDevSlackUserIds ?? []).join(',');
  defaults.groups.admin.slackUserGroupHandle = input.coreDevSlackUserGroup?.trim() ?? '';

  return toResolvedAccessControlConfig(defaults, input.ownerSlackUserIds);
}

export function toResolvedAccessControlConfig(
  settings: Partial<AccessControlSettings> | undefined,
  ownerSlackUserIds: string[],
): AccessControlConfig {
  const hydrated = hydrateAccessControlSettings(settings);

  return {
    mode: hydrated.mode,
    groups: {
      viewer: toResolvedAccessGroup('viewer', hydrated.groups.viewer, ownerSlackUserIds),
      reviewer: toResolvedAccessGroup('reviewer', hydrated.groups.reviewer, ownerSlackUserIds),
      builder: toResolvedAccessGroup('builder', hydrated.groups.builder, ownerSlackUserIds),
      admin: toResolvedAccessGroup('admin', hydrated.groups.admin, ownerSlackUserIds),
      owner: toResolvedAccessGroup('owner', hydrated.groups.owner, ownerSlackUserIds),
    },
  };
}

/**
 * Maps each capability to the *minimum* legacy tier that grants it. Two uses:
 *
 * 1. D2 left this in place as the lookup that translates Capability →
 *    AccessLevel for the wrapped `evaluateAccess` path.
 * 2. D3 also uses this as the inverse of `LEGACY_TIER_TO_CAPABILITIES`:
 *    when `deriveBundlesFromLegacy` builds a Bundle for tier T, the bundle's
 *    capability set is exactly the capabilities that pin to T or any lower
 *    tier (cumulative).
 *
 * `investigate` stays at `viewer` per the D2 parity decision —
 * `resolveRequiredAccessLevel('INVESTIGATION')` returned `viewer` historically.
 */
const CAPABILITY_TO_LEGACY_TIER: Record<Capability, AccessLevel> = {
  query_codebase: 'viewer',
  chat: 'viewer',
  miniog_dossier_self: 'viewer',
  investigate: 'viewer',
  submit_pr_review: 'reviewer',
  comment_pr: 'reviewer',
  start_implementation: 'builder',
  deploy_prod: 'admin',
  dev_assist: 'admin',
  miniog_dossier_admin: 'admin',
  manage_access: 'owner',
};

const ALL_CAPABILITIES: Capability[] = Object.keys(CAPABILITY_TO_LEGACY_TIER) as Capability[];

/**
 * Cumulative tier → capability set. Derived from `CAPABILITY_TO_LEGACY_TIER`
 * so the two stay coherent: a bundle for tier T includes every capability
 * pinned at rank ≤ rank(T). `owner` gets every capability so the table is
 * internally complete even though owner bypass short-circuits the check.
 */
export const LEGACY_TIER_TO_CAPABILITIES: Record<AccessGroupKey, Capability[]> = (() => {
  const result = {} as Record<AccessGroupKey, Capability[]>;
  for (const tier of ACCESS_GROUP_KEYS) {
    if (tier === 'owner') {
      result[tier] = [...ALL_CAPABILITIES];
      continue;
    }
    result[tier] = ALL_CAPABILITIES.filter(cap => ACCESS_RANK[CAPABILITY_TO_LEGACY_TIER[cap]] <= ACCESS_RANK[tier]);
  }
  return result;
})();

/**
 * Inverse-ish lookup for the `evaluateAccess` wrapper: pick a capability
 * that is granted by `level` but NOT by any strictly-lower tier. Calling
 * `evaluateCapability(rep)` then returns the same allowed/denyReason as the
 * legacy `evaluateAccess(level)` did because the cumulative capability sets
 * partition tiers exactly. Owner falls back to admin's representative since
 * the owner bypass short-circuits before the capability check.
 */
const LEVEL_TO_REPRESENTATIVE_CAPABILITY: Record<AccessLevel, Capability> = {
  viewer: 'query_codebase',
  reviewer: 'submit_pr_review',
  builder: 'start_implementation',
  admin: 'deploy_prod',
  // Owner needs an owner-exclusive capability so `evaluateAccess(requiredLevel: 'owner')`
  // distinguishes admin from owner. `manage_access` pins to the `owner` tier in
  // CAPABILITY_TO_LEGACY_TIER, so admin's bundle does NOT grant it.
  owner: 'manage_access',
};

/**
 * Resolves `bundle.resolvedUserIds` from `manualUserIds` plus (for admin /
 * owner bundles) the configured owner user IDs. Slack subteam-handle
 * expansion happens later via the 30-min `setResolvedGroupMembers` refresh;
 * this just gives us a sane starting set immediately after a load.
 *
 * Mirrors the legacy `toResolvedAccessGroup` semantics: only admin/owner
 * bundles auto-include `ownerSlackUserIds`. Other bundles (viewer, reviewer,
 * builder, custom) get only their parsed `manualUserIds` until subteam
 * resolution runs.
 */
export function hydrateBundleUserIds(bundles: Bundle[], ownerSlackUserIds: string[]): Bundle[] {
  return bundles.map(bundle => {
    const manualUserIds = parseDelimitedIds(bundle.manualUserIds);
    const includesOwners = bundle.name === 'admin' || bundle.name === 'owner';
    const resolvedUserIds = includesOwners ? uniqueList([...ownerSlackUserIds, ...manualUserIds]) : manualUserIds;
    return { ...bundle, resolvedUserIds };
  });
}

/**
 * Builds the capability-bundles view of a legacy `AccessControlConfig`.
 * Called by `mapSettingsToConfig` so `AppConfig.bundles` is always populated
 * when `accessControl` is. Each bundle's `resolvedUserIds` is a snapshot —
 * `setResolvedGroupMembers` mutates both `accessControl.groups[X].resolvedUserIds`
 * AND the matching `bundles[X].resolvedUserIds` so live subteam-membership
 * updates flow through to capability checks without a restart.
 */
export function deriveBundlesFromLegacy(accessControl: AccessControlConfig): Bundle[] {
  return ACCESS_GROUP_KEYS.map(key => {
    const group = accessControl.groups[key];
    return {
      name: key,
      slackUserGroupHandle: group.slackUserGroupHandle,
      manualUserIds: group.manualUserIds,
      resolvedUserIds: [...group.resolvedUserIds],
      capabilities: [...LEGACY_TIER_TO_CAPABILITIES[key]],
      allowedChannelIds: [...group.resolvedChannelIds],
      allowIm: group.allowIm,
      allowMpim: group.allowMpim,
    };
  });
}

/**
 * Maps a `WorkflowIntent` to the canonical `Capability` that gates the
 * workflow. The router (`router/taskRouter.ts:221`) still calls
 * `evaluateAccess` with a tier; callers that want capability-shaped access
 * should call this and then `evaluateCapability` directly (D4).
 */
export function intentToCapability(intent: WorkflowIntent): Capability {
  switch (intent) {
    case 'PR_REVIEW':
      return 'submit_pr_review';
    case 'IMPLEMENTATION':
    case 'OWNER_AUTOPILOT':
      return 'start_implementation';
    // Webapp-QA drives a live app but ships no code — builder-tier, reusing
    // the implementation capability rather than minting a new one for the MVP.
    case 'WEBAPP_QA':
      return 'start_implementation';
    case 'INVESTIGATION':
      return 'investigate';
    case 'DEPLOY':
      return 'deploy_prod';
    case 'DEV_ASSIST':
      return 'dev_assist';
    case 'INFORMATIONAL':
      return 'query_codebase';
    case 'CONVERSATIONAL':
      return 'chat';
    case 'MINIOG_DOSSIER':
      return 'miniog_dossier_self';
    case 'UNKNOWN':
    case 'NONE':
    default:
      return 'query_codebase';
  }
}

/**
 * Side-effect class of a workflow — a separate axis from `Capability` /
 * `resolveRequiredAccessLevel`. Answers "can a low-confidence switch INTO this
 * workflow act on, or falsely imply completion of, work it did not do?" and
 * drives the classifier-confidence guard in `router/taskRouter.ts` (#348 RC1).
 *
 *  - 'mutating' : opens PRs / writes code / deploys / posts a review verdict.
 *  - 'chat'     : free-form conversation. Historically hallucinated a
 *                 "fix done" reply (RCA p1779086230428739) — treated as risky
 *                 on a downgrade even though agenticEntry now forbids
 *                 completion claims (defense in depth).
 *  - 'answer'   : read-only diagnose/answer. Reports findings and stops; it
 *                 cannot imply work shipped, so it is always a safe downgrade
 *                 target. (INFORMATIONAL, INVESTIGATION, DEV_ASSIST, …)
 *  - 'none'     : silent, no surface output.
 *
 * Kept distinct from `intentToCapability` / `resolveRequiredAccessLevel` on
 * purpose: INVESTIGATION and INFORMATIONAL share this class but differ in
 * capability; collapsing the two axes is what made the old tier-rank guard
 * direction/tier-blind.
 */
export type WorkflowSideEffect = 'mutating' | 'answer' | 'chat' | 'none';

export function workflowSideEffect(intent: WorkflowIntent): WorkflowSideEffect {
  switch (intent) {
    case 'IMPLEMENTATION':
    case 'OWNER_AUTOPILOT':
    case 'PR_REVIEW':
    case 'DEPLOY':
      return 'mutating';
    case 'CONVERSATIONAL':
      return 'chat';
    case 'NONE':
      return 'none';
    case 'INFORMATIONAL':
    case 'INVESTIGATION':
    case 'DEV_ASSIST':
    case 'MINIOG_DOSSIER':
    case 'WEBAPP_QA': // QA reports findings against a running app; it cannot imply code shipped.
    case 'UNKNOWN':
    default:
      return 'answer';
  }
}

/**
 * @deprecated Maps a workflow intent to a tier in the legacy hierarchy. The
 * agent-owned arch will check capabilities directly via `evaluateCapability`;
 * this mapping is the bridge so the router (`router/taskRouter.ts:221`) keeps
 * compiling unchanged during the migration.
 */
export function resolveRequiredAccessLevel(intent: WorkflowIntent): AccessLevel {
  switch (intent) {
    case 'PR_REVIEW':
      return 'reviewer';
    case 'IMPLEMENTATION':
    case 'OWNER_AUTOPILOT':
    case 'WEBAPP_QA':
      return 'builder';
    case 'DEPLOY':
    case 'DEV_ASSIST':
      return 'admin';
    case 'INFORMATIONAL':
    case 'CONVERSATIONAL':
    case 'MINIOG_DOSSIER':
    case 'UNKNOWN':
    case 'NONE':
    default:
      return 'viewer';
  }
}

export function getAdminUserIds(config: AppConfig): string[] {
  // Post-D5 the `bundles` table is the source of truth for membership —
  // prefer it. The legacy `accessControl` view is only used as fallback
  // when bundles aren't loaded (fresh install / hand-built test fixture).
  if (config.bundles && config.bundles.length > 0) {
    const adminBundle = config.bundles.find(b => b.name === 'admin');
    const ownerBundle = config.bundles.find(b => b.name === 'owner');
    return uniqueList([
      ...config.ownerSlackUserIds,
      ...(adminBundle?.resolvedUserIds ?? []),
      ...(ownerBundle?.resolvedUserIds ?? []),
    ]);
  }
  if (config.accessControl) {
    return uniqueList([
      ...config.ownerSlackUserIds,
      ...config.accessControl.groups.admin.resolvedUserIds,
      ...config.accessControl.groups.owner.resolvedUserIds,
    ]);
  }
  return uniqueList([...config.ownerSlackUserIds, ...(config.coreDevSlackUserIds ?? [])]);
}

/** Slack subteam IDs look like S02HXP05ZNJ — `<!subteam^…>` accepts nothing else. */
const SLACK_SUBTEAM_ID_RE = /^S[A-Z0-9]{6,}$/;

/**
 * Build a concise Slack mention string for an admin-approval prompt.
 * Prefers the core-dev Slack user group (a single `<!subteam^…>` mention
 * that pings the whole group) over tagging every individual admin, which
 * turns the thread into a wall of twenty `<@U…>` pings.
 *
 * `<!subteam^…>` only accepts the subteam ID, never the handle — a raw
 * handle renders as dead text and pings nobody (issue #334, bug C). The IDs
 * are pre-resolved by the 30-min access refresh; a configured value that
 * already looks like an ID is used as-is. When no ID is available
 * (unresolved handle, cold start), fall back to tagging owners directly,
 * and to an empty string if nothing is available.
 */
export function formatAdminMention(config: AppConfig): string {
  const adminIds = config.accessControl?.groups.admin.resolvedSubteamIds?.filter(Boolean) ?? [];
  const coreDevIds = config.resolvedCoreDevSubteamIds?.filter(Boolean) ?? [];
  const resolvedIds = adminIds.length > 0 ? adminIds : coreDevIds;
  if (resolvedIds.length > 0) {
    return resolvedIds.map(id => `<!subteam^${id}>`).join(' ');
  }

  // Back-compat: installs that configured the subteam ID directly where the
  // handle goes keep working without a resolution round-trip.
  const configured =
    (config.accessControl?.groups.admin.slackUserGroupHandle ?? '').trim() ||
    (config.coreDevSlackUserGroup ?? '').trim();
  const literalIds = configured
    .split(',')
    .map(part => part.trim().replace(/^@/, ''))
    .filter(part => SLACK_SUBTEAM_ID_RE.test(part));
  if (literalIds.length > 0) {
    return literalIds.map(id => `<!subteam^${id}>`).join(' ');
  }

  const owners = (config.ownerSlackUserIds ?? []).filter(Boolean);
  if (owners.length > 0) {
    return owners.map(id => `<@${id}>`).join(' ');
  }
  return '';
}

export function getConfiguredAccessControl(config: AppConfig): AccessControlConfig {
  return (
    config.accessControl ??
    buildLegacyAccessControlConfig({
      ownerSlackUserIds: config.ownerSlackUserIds,
      coreDevSlackUserIds: config.coreDevSlackUserIds,
      coreDevSlackUserGroup: config.coreDevSlackUserGroup,
      allowedChannelsForBugFix: config.allowedChannelsForBugFix,
    })
  );
}

export function setResolvedGroupMembers(params: {
  config: AppConfig;
  groupKey: AccessGroupKey;
  members: string[];
  /** Slack subteam IDs backing this group's handle(s) — see formatAdminMention. */
  subteamIds?: string[];
}): void {
  const accessControl = getConfiguredAccessControl(params.config);
  // Post-D5 the `bundles` table is the source of truth for membership — the
  // desktop bundle editor writes there, not into `access_control_groups`.
  // Read `manualUserIds` from the bundle when present so the 30-min subteam
  // refresh doesn't overwrite freshly-added members with stale legacy data.
  // Falls back to the legacy table only when no matching bundle exists
  // (e.g. fresh install before bundles are seeded).
  const bundle = params.config.bundles?.find(b => b.name === params.groupKey);
  const manualUserIds = parseDelimitedIds(bundle?.manualUserIds ?? accessControl.groups[params.groupKey].manualUserIds);
  const includesOwners = params.groupKey === 'admin' || params.groupKey === 'owner';
  const nextMembers = includesOwners
    ? uniqueList([...params.config.ownerSlackUserIds, ...manualUserIds, ...params.members])
    : uniqueList([...manualUserIds, ...params.members]);

  accessControl.groups[params.groupKey].resolvedUserIds = nextMembers;
  if (params.subteamIds !== undefined) {
    accessControl.groups[params.groupKey].resolvedSubteamIds = uniqueList(params.subteamIds);
  }
  params.config.accessControl = accessControl;

  // Mirror into the capability-bundles view so live subteam-membership
  // changes (refreshed every 30 min) propagate to `evaluateCapability`
  // without a config reload. Bundle name == legacy tier key during the
  // migration, so the lookup is direct.
  //
  // Note: the bundle hot-reload path (index.ts, access cache signal) rebuilds
  // config.bundles via hydrateBundleUserIds WITHOUT resolvedSubteamIds; that's
  // harmless today because formatAdminMention reads accessControl, not
  // bundles — keep it that way (or carry the IDs) if that read ever moves.
  if (bundle) {
    bundle.resolvedUserIds = [...nextMembers];
    if (params.subteamIds !== undefined) {
      bundle.resolvedSubteamIds = uniqueList(params.subteamIds);
    }
  }
}

/**
 * Channel-allowed predicate against a capability bundle. Owner bundle is
 * channel-unrestricted (mirrors the owner short-circuit in the legacy
 * `channelAllowed`); editing channel fields on the owner bundle is a no-op
 * — configure ownership through `ownerSlackUserIds`.
 */
function channelAllowedForBundle(bundle: Bundle, channelId: string, channelType?: string): boolean {
  if (bundle.name === 'owner') {
    return true;
  }
  if (channelType === 'im') {
    return bundle.allowIm;
  }
  if (channelType === 'mpim') {
    return bundle.allowMpim;
  }
  return bundle.allowedChannelIds.includes(channelId);
}

/**
 * Returns the capability-bundles view of access for this config, falling
 * back to deriving from the legacy `AccessControlConfig` when `config.bundles`
 * is undefined. The fallback is what keeps legacy test fixtures (and any
 * caller that builds `AppConfig` by hand) working without changes.
 */
function getBundlesForConfig(config: AppConfig): Bundle[] {
  if (config.bundles) return config.bundles;
  return deriveBundlesFromLegacy(getConfiguredAccessControl(config));
}

/**
 * Capability-shaped access check. Source of truth as of D3 — reads from
 * `config.bundles` (the capability-bundles view) rather than the legacy
 * tier-shaped `AccessControlConfig`. The three `AccessDenyReason` buckets
 * and their user-facing copy are preserved exactly per
 * `[[redesign_access_deny_copy_preserved]]`.
 *
 * `evaluateAccess` is now a thin wrapper that translates `requiredLevel` →
 * representative `Capability` and delegates here.
 */
export function evaluateCapability(params: {
  config: AppConfig;
  userId: string;
  channelId: string;
  channelType?: string;
  capability: Capability;
}): AccessDecision {
  const { config, userId, channelId, channelType, capability } = params;
  const requiredLevel = CAPABILITY_TO_LEGACY_TIER[capability];

  // 1. Owner bypass — short-circuit before any bundle lookup.
  if (config.ownerSlackUserIds.includes(userId)) {
    return {
      allowed: true,
      ownerBypass: true,
      requiredLevel,
      matchedGroups: ['owner'],
      userGroups: ['owner'],
    };
  }

  const bundles = getBundlesForConfig(config);
  const userBundles = bundles.filter(b => b.resolvedUserIds.includes(userId));
  const matchedBundles = userBundles.filter(b => channelAllowedForBundle(b, channelId, channelType));
  const grantedCapabilities = new Set(matchedBundles.flatMap(b => b.capabilities));
  const allowed = grantedCapabilities.has(capability);

  // Bundle names happen to be the 5 legacy tier names during the migration,
  // so the AccessDecision's userGroups/matchedGroups fields carry the same
  // string identifiers `taskRouter.ts:250–258` already logs. When bundles
  // become first-class (D5+), this surface widens to arbitrary bundle names.
  const userGroups = userBundles.map(b => b.name as AccessGroupKey);
  const matchedGroups = matchedBundles.map(b => b.name as AccessGroupKey);

  let reason: string | undefined;
  let denyReason: AccessDenyReason | undefined;
  if (!allowed) {
    const isDM = channelType === 'im' || channelType === 'mpim';
    // Among bundles the user belongs to (regardless of channel), do any grant
    // the requested capability? If yes, the deny is purely about channel scope.
    const anyBundleGrants = userBundles.some(b => b.capabilities.includes(capability));

    if (userBundles.length === 0) {
      denyReason = 'NOT_ON_ACCESS_LIST';
      reason = "Sorry, you're not on the access list. Please ask an admin to add you.";
    } else if (!anyBundleGrants) {
      denyReason = 'INSUFFICIENT_ROLE';
      reason =
        'Sorry, this kind of request needs a higher access level than your role allows. Please contact an admin.';
    } else {
      denyReason = 'CHANNEL_NOT_ENABLED';
      reason = isDM
        ? "Sorry, DMs aren't enabled for your role. Please contact an admin."
        : "Sorry, I'm not enabled for this kind of request in this channel. Please contact an admin.";
    }
  }

  return {
    allowed,
    ownerBypass: false,
    requiredLevel,
    matchedGroups,
    userGroups,
    reason,
    denyReason,
  };
}

/**
 * @deprecated Tier-shaped access check. Now a thin wrapper around
 * `evaluateCapability` — translates `requiredLevel` → representative
 * `Capability` and delegates. Removed in D6 once the router cuts over.
 *
 * The `accessControl` param is honored when provided (test fixtures that
 * pass a one-off config without bundles still work via the
 * `getBundlesForConfig` legacy fallback).
 */
export function evaluateAccess(params: {
  config: AppConfig;
  accessControl?: AccessControlConfig;
  userId: string;
  channelId: string;
  channelType?: string;
  requiredLevel: AccessLevel;
}): AccessDecision {
  // If a caller passed an explicit accessControl override, translate it to
  // bundles for the duration of this call so the override still wins. This
  // is exercised by the test fixtures in `accessControl.test.ts`.
  const effectiveConfig: AppConfig = params.accessControl
    ? { ...params.config, accessControl: params.accessControl, bundles: deriveBundlesFromLegacy(params.accessControl) }
    : params.config;

  const capability = LEVEL_TO_REPRESENTATIVE_CAPABILITY[params.requiredLevel];
  const decision = evaluateCapability({
    config: effectiveConfig,
    userId: params.userId,
    channelId: params.channelId,
    channelType: params.channelType,
    capability,
  });

  // Preserve the legacy `requiredLevel` field on the returned decision —
  // tests and `taskRouter.ts` both inspect it.
  return { ...decision, requiredLevel: params.requiredLevel };
}
