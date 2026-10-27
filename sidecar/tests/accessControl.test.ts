import { describe, expect, it } from 'vitest';
import {
  buildLegacyAccessControlConfig,
  deriveBundlesFromLegacy,
  evaluateAccess,
  evaluateCapability,
  getAdminUserIds,
  hydrateBundleUserIds,
  intentToCapability,
  resolveRequiredAccessLevel,
  toResolvedAccessControlConfig,
  workflowSideEffect,
} from '../src/access/control.js';
import type { AppConfig, Capability, WorkflowIntent } from '../src/types/contracts.js';

function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
  const ownerSlackUserIds = overrides?.ownerSlackUserIds ?? ['UOWNER1'];
  const accessControl =
    overrides?.accessControl ??
    toResolvedAccessControlConfig(
      {
        mode: 'enforce',
        groups: {
          viewer: {
            manualUserIds: 'UVIEWER',
            allowedChannelIds: 'C-VIEW',
            allowIm: true,
            allowMpim: false,
          },
          reviewer: {
            manualUserIds: 'UREVIEW',
            allowedChannelIds: 'C-REVIEW',
            allowIm: false,
            allowMpim: false,
          },
          builder: {
            manualUserIds: 'UBUILDER',
            allowedChannelIds: 'C-BUILD',
            allowIm: false,
            allowMpim: false,
          },
          admin: {
            manualUserIds: 'UADMIN',
            allowedChannelIds: 'C-ADMIN',
            allowIm: true,
            allowMpim: true,
          },
          owner: {
            manualUserIds: '',
            allowedChannelIds: '',
            allowIm: false,
            allowMpim: false,
          },
        },
      },
      ownerSlackUserIds,
    );

  return {
    platformPolicy: 'macos_only',
    bundleTargets: ['app', 'dmg'],
    ownerSlackUserIds,
    coreDevSlackUserIds: ['UOWNER1'],
    botUserId: 'UBOT1',
    slackBotToken: 'xoxb-test',
    slackAppToken: 'xapp-test',
    bugsAndUpdatesChannelId: 'C-BUILD',
    allowedChannelsForBugFix: ['C-BUILD'],
    repoPaths: {
      newtonWeb: '/Users/dipesh/code/newton-web',
      newtonApi: '/Users/dipesh/code/newton-api',
    },
    unknownTaskPolicy: 'desktop_only',
    uncertainRepoPolicy: 'desktop_only',
    unmappedPrRepoPolicy: 'desktop_only',
    maxConcurrentJobs: 2,
    repoClassifierThreshold: 0.75,
    allowedPrOrg: 'Newton-School',
    multiAgentEnabled: false,
    agentBackend: 'codex',
    prReviewTimeoutMs: 120_000,
    bugFixTimeoutMs: 120_000,
    pmTaskTimeoutMs: 120_000,
    accessControl,
    // Production loads bundles via `mapSettingsToConfig`; the test fixture mirrors that.
    bundles: deriveBundlesFromLegacy(accessControl),
    ...overrides,
  };
}

/** Lists `userId` on bundle `name`, as Settings does. */
function addToBundle(config: AppConfig, name: string, userId: string): void {
  config.bundles = hydrateBundleUserIds(
    (config.bundles ?? []).map(bundle =>
      bundle.name === name
        ? { ...bundle, manualUserIds: [bundle.manualUserIds, userId].filter(Boolean).join(',') }
        : bundle,
    ),
    config.ownerSlackUserIds,
  );
}

describe('access control evaluator', () => {
  it('maps workflow intents to the correct required level', () => {
    expect(resolveRequiredAccessLevel('CONVERSATIONAL')).toBe('viewer');
    expect(resolveRequiredAccessLevel('PR_REVIEW')).toBe('reviewer');
    expect(resolveRequiredAccessLevel('IMPLEMENTATION')).toBe('builder');
    expect(resolveRequiredAccessLevel('DEPLOY')).toBe('admin');
    expect(resolveRequiredAccessLevel('DEV_ASSIST')).toBe('admin');
  });

  it('allows viewers only in configured channels and DMs', () => {
    const config = makeConfig();
    expect(
      evaluateAccess({
        config,
        userId: 'UVIEWER',
        channelId: 'C-VIEW',
        requiredLevel: 'viewer',
      }).allowed,
    ).toBe(true);

    expect(
      evaluateAccess({
        config,
        userId: 'UVIEWER',
        channelId: 'D123',
        channelType: 'im',
        requiredLevel: 'viewer',
      }).allowed,
    ).toBe(true);

    expect(
      evaluateAccess({
        config,
        userId: 'UVIEWER',
        channelId: 'C-VIEW',
        requiredLevel: 'builder',
      }).allowed,
    ).toBe(false);
  });

  it('allows reviewers to review but not build or deploy', () => {
    const config = makeConfig();
    expect(
      evaluateAccess({
        config,
        userId: 'UREVIEW',
        channelId: 'C-REVIEW',
        requiredLevel: 'reviewer',
      }).allowed,
    ).toBe(true);

    expect(
      evaluateAccess({
        config,
        userId: 'UREVIEW',
        channelId: 'C-REVIEW',
        requiredLevel: 'builder',
      }).allowed,
    ).toBe(false);

    expect(
      evaluateAccess({
        config,
        userId: 'UREVIEW',
        channelId: 'C-REVIEW',
        requiredLevel: 'admin',
      }).allowed,
    ).toBe(false);
  });

  it('allows builders to implement but not deploy', () => {
    const config = makeConfig();
    expect(
      evaluateAccess({
        config,
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        requiredLevel: 'builder',
      }).allowed,
    ).toBe(true);

    expect(
      evaluateAccess({
        config,
        userId: 'UBUILDER',
        channelId: 'C-BUILD',
        requiredLevel: 'admin',
      }).allowed,
    ).toBe(false);
  });

  it('allows admins to deploy and use wt commands in channels and DMs', () => {
    const config = makeConfig();
    expect(
      evaluateAccess({
        config,
        userId: 'UADMIN',
        channelId: 'C-ADMIN',
        requiredLevel: 'admin',
      }).allowed,
    ).toBe(true);

    expect(
      evaluateAccess({
        config,
        userId: 'UADMIN',
        channelId: 'D123',
        channelType: 'im',
        requiredLevel: 'admin',
      }).allowed,
    ).toBe(true);
  });

  it('always allows the owner regardless of group membership or channel rules', () => {
    const config = makeConfig();
    const decision = evaluateAccess({
      config,
      userId: 'UOWNER1',
      channelId: 'C-UNLISTED',
      requiredLevel: 'admin',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.ownerBypass).toBe(true);
  });

  it('pre-resolves channel IDs and adds the owners to the admin group', () => {
    const config = makeConfig();

    expect(config.accessControl?.groups.builder.resolvedChannelIds).toEqual(['C-BUILD']);
    expect(config.accessControl?.groups.reviewer.resolvedUserIds).toEqual(['UREVIEW']);
    expect(config.accessControl?.groups.admin.resolvedUserIds).toEqual(['UOWNER1', 'UADMIN']);
  });

  describe('owner access level', () => {
    it('auto-populates the owner group resolvedUserIds from ownerSlackUserIds', () => {
      const config = makeConfig();
      expect(config.accessControl?.groups.owner.resolvedUserIds).toEqual(['UOWNER1']);
    });

    it('grants owners rank-4 access for owner-level requirements', () => {
      const config = makeConfig();
      const decision = evaluateAccess({
        config,
        userId: 'UOWNER1',
        channelId: 'C-UNLISTED',
        requiredLevel: 'owner',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.ownerBypass).toBe(true);
      expect(decision.matchedGroups).toEqual(['owner']);
      expect(decision.userGroups).toEqual(['owner']);
    });

    it('grants rank-4 access via the owner group when the user is not in ownerSlackUserIds', () => {
      // Configures a user who is in the owner group but NOT in ownerSlackUserIds,
      // so the early bypass at evaluateAccess does not fire and the rank-4 group path
      // is exercised on its own.
      const config = makeConfig({ ownerSlackUserIds: [] });
      addToBundle(config, 'owner', 'UPROMOTED');

      const decision = evaluateAccess({
        config,
        userId: 'UPROMOTED',
        channelId: 'C-UNLISTED',
        requiredLevel: 'owner',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.ownerBypass).toBe(false);
      expect(decision.matchedGroups).toContain('owner');
    });

    it('surfaces owner-group members via getAdminUserIds for admin mentions and approval gates', () => {
      const config = makeConfig({ ownerSlackUserIds: [] });
      addToBundle(config, 'owner', 'UPROMOTED');

      expect(getAdminUserIds(config)).toContain('UPROMOTED');
    });

    it('denies non-owner admins when the required level is owner', () => {
      const config = makeConfig();
      const decision = evaluateAccess({
        config,
        userId: 'UADMIN',
        channelId: 'C-ADMIN',
        requiredLevel: 'owner',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.denyReason).toBe('INSUFFICIENT_ROLE');
    });

    it('treats the owner group as channel-unrestricted (no allowedChannel match required)', () => {
      const config = makeConfig({
        ownerSlackUserIds: [],
      });
      addToBundle(config, 'owner', 'UPROMOTED');

      const decision = evaluateAccess({
        config,
        userId: 'UPROMOTED',
        channelId: 'C-UNLISTED',
        requiredLevel: 'admin',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.matchedGroups).toContain('owner');
    });
  });

  describe('denial reasons', () => {
    it('returns NOT_ON_ACCESS_LIST when the user is in no group', () => {
      const config = makeConfig();
      const decision = evaluateAccess({
        config,
        userId: 'UNKNOWN',
        channelId: 'C-VIEW',
        requiredLevel: 'viewer',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.denyReason).toBe('NOT_ON_ACCESS_LIST');
      expect(decision.reason).toBe("Sorry, you're not on the access list. Please ask an admin to add you.");
    });

    it('returns INSUFFICIENT_ROLE when the user is in a group but rank is too low', () => {
      const config = makeConfig();
      const decision = evaluateAccess({
        config,
        userId: 'UVIEWER',
        channelId: 'C-VIEW',
        requiredLevel: 'builder',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.denyReason).toBe('INSUFFICIENT_ROLE');
      expect(decision.reason).toBe(
        'Sorry, this kind of request needs a higher access level than your role allows. Please contact an admin.',
      );
    });

    it('returns CHANNEL_NOT_ENABLED with channel copy when role qualifies but channel is not in the role list', () => {
      const config = makeConfig();
      const decision = evaluateAccess({
        config,
        userId: 'UBUILDER',
        channelId: 'C-VIEW',
        requiredLevel: 'builder',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.denyReason).toBe('CHANNEL_NOT_ENABLED');
      expect(decision.reason).toBe(
        "Sorry, I'm not enabled for this kind of request in this channel. Please contact an admin.",
      );
    });

    it('returns CHANNEL_NOT_ENABLED with DM copy when role qualifies but IM is disabled for the role', () => {
      const config = makeConfig();
      const decision = evaluateAccess({
        config,
        userId: 'UBUILDER',
        channelId: 'D123',
        channelType: 'im',
        requiredLevel: 'builder',
      });

      expect(decision.allowed).toBe(false);
      expect(decision.denyReason).toBe('CHANNEL_NOT_ENABLED');
      expect(decision.reason).toBe("Sorry, DMs aren't enabled for your role. Please contact an admin.");
    });

    it('owner bypass wins over every denial branch', () => {
      const config = makeConfig();
      const decision = evaluateAccess({
        config,
        userId: 'UOWNER1',
        channelId: 'C-UNLISTED',
        requiredLevel: 'admin',
      });

      expect(decision.allowed).toBe(true);
      expect(decision.ownerBypass).toBe(true);
      expect(decision.denyReason).toBeUndefined();
      expect(decision.reason).toBeUndefined();
    });
  });

  describe('owner-mention grant (#owner-mention-readonly)', () => {
    it('grants a non-allowlisted author read-only access when the owner is mentioned', () => {
      const config = makeConfig();
      const decision = evaluateAccess({
        config,
        userId: 'UNKNOWN', // not on any access list
        channelId: 'C-UNLISTED',
        requiredLevel: 'viewer',
        ownerMentioned: true,
      });

      expect(decision.allowed).toBe(true);
      expect(decision.ownerMentionGrant).toBe(true);
      expect(decision.ownerBypass).toBe(false);
      expect(decision.denyReason).toBeUndefined();
    });

    it('does NOT extend the owner-mention grant to write/elevated workflows', () => {
      const config = makeConfig();
      const decision = evaluateAccess({
        config,
        userId: 'UNKNOWN',
        channelId: 'C-UNLISTED',
        requiredLevel: 'builder', // IMPLEMENTATION-tier
        ownerMentioned: true,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.denyReason).toBe('NOT_ON_ACCESS_LIST');
    });

    it('still denies a read-only request when the owner is NOT mentioned (unchanged)', () => {
      const config = makeConfig();
      const decision = evaluateAccess({
        config,
        userId: 'UNKNOWN',
        channelId: 'C-UNLISTED',
        requiredLevel: 'viewer',
        ownerMentioned: false,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.denyReason).toBe('NOT_ON_ACCESS_LIST');
    });
  });

  it('seeds legacy builder and admin permissions from previous config', () => {
    const accessControl = buildLegacyAccessControlConfig({
      ownerSlackUserIds: ['UOWNER1'],
      coreDevSlackUserIds: ['UCOREDEV1'],
      allowedChannelsForBugFix: ['C-BUGS', 'C-OPS'],
    });

    expect(accessControl.mode).toBe('audit');
    expect(accessControl.groups.builder.allowedChannelIds).toBe('C-BUGS,C-OPS');
    expect(accessControl.groups.builder.resolvedChannelIds).toEqual(['C-BUGS', 'C-OPS']);
    expect(accessControl.groups.admin.allowedChannelIds).toBe('C-BUGS,C-OPS');
    expect(accessControl.groups.admin.allowIm).toBe(true);
    expect(accessControl.groups.admin.resolvedUserIds).toEqual(['UOWNER1', 'UCOREDEV1']);
  });
});

describe('capability-shaped access (D2 wrapper over legacy tiers)', () => {
  it('intentToCapability maps every WorkflowIntent to a Capability', () => {
    const cases: Array<[WorkflowIntent, Capability]> = [
      ['PR_REVIEW', 'submit_pr_review'],
      ['IMPLEMENTATION', 'start_implementation'],
      ['OWNER_AUTOPILOT', 'start_implementation'],
      ['INVESTIGATION', 'investigate'],
      ['DEPLOY', 'deploy_prod'],
      ['DEV_ASSIST', 'dev_assist'],
      ['INFORMATIONAL', 'query_codebase'],
      ['CONVERSATIONAL', 'chat'],
      ['MINIOG_DOSSIER', 'miniog_dossier_self'],
      ['UNKNOWN', 'query_codebase'],
      ['NONE', 'query_codebase'],
    ];
    for (const [intent, expected] of cases) {
      expect(intentToCapability(intent)).toBe(expected);
    }
  });

  it('workflowSideEffect classifies every WorkflowIntent (#348 RC1)', () => {
    const cases: Array<[WorkflowIntent, ReturnType<typeof workflowSideEffect>]> = [
      ['IMPLEMENTATION', 'mutating'],
      ['OWNER_AUTOPILOT', 'mutating'],
      ['PR_REVIEW', 'mutating'],
      ['DEPLOY', 'mutating'],
      ['CONVERSATIONAL', 'chat'],
      ['NONE', 'none'],
      ['INFORMATIONAL', 'answer'],
      ['INVESTIGATION', 'answer'],
      ['DEV_ASSIST', 'answer'],
      ['MINIOG_DOSSIER', 'answer'],
      ['UNKNOWN', 'answer'],
    ];
    for (const [intent, expected] of cases) {
      expect(workflowSideEffect(intent)).toBe(expected);
    }
  });

  it('evaluateCapability returns owner bypass for owner IDs', () => {
    const config = makeConfig();
    const decision = evaluateCapability({
      config,
      userId: 'UOWNER1',
      channelId: 'C-ANY',
      capability: 'deploy_prod',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.ownerBypass).toBe(true);
  });

  it('evaluateCapability denies NOT_ON_ACCESS_LIST for users in zero groups', () => {
    const config = makeConfig();
    const decision = evaluateCapability({
      config,
      userId: 'UNOBODY',
      channelId: 'C-VIEW',
      capability: 'query_codebase',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denyReason).toBe('NOT_ON_ACCESS_LIST');
    expect(decision.reason).toBe("Sorry, you're not on the access list. Please ask an admin to add you.");
  });

  it('evaluateCapability denies INSUFFICIENT_ROLE when user has the wrong tier', () => {
    const config = makeConfig();
    // UVIEWER has viewer tier; deploy_prod requires admin tier → INSUFFICIENT_ROLE.
    const decision = evaluateCapability({
      config,
      userId: 'UVIEWER',
      channelId: 'C-VIEW',
      capability: 'deploy_prod',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denyReason).toBe('INSUFFICIENT_ROLE');
    expect(decision.reason).toBe(
      'Sorry, this kind of request needs a higher access level than your role allows. Please contact an admin.',
    );
  });

  it('evaluateCapability denies CHANNEL_NOT_ENABLED when user has the tier but not the channel', () => {
    const config = makeConfig();
    // UADMIN belongs to the admin group, allowed in C-ADMIN. Trying to act in C-VIEW
    // (a channel that admin is not enabled in) → CHANNEL_NOT_ENABLED.
    const decision = evaluateCapability({
      config,
      userId: 'UADMIN',
      channelId: 'C-VIEW',
      capability: 'deploy_prod',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denyReason).toBe('CHANNEL_NOT_ENABLED');
    expect(decision.reason).toBe(
      "Sorry, I'm not enabled for this kind of request in this channel. Please contact an admin.",
    );
  });

  it('evaluateCapability allows the matched capability in the right channel', () => {
    const config = makeConfig();
    const decision = evaluateCapability({
      config,
      userId: 'UADMIN',
      channelId: 'C-ADMIN',
      capability: 'deploy_prod',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.ownerBypass).toBe(false);
  });

  it('evaluateCapability preserves the DM-specific channel-deny copy', () => {
    const config = makeConfig();
    // UVIEWER has viewer tier with allowIm=true, so DM is fine for viewer-level
    // capabilities — but UREVIEW has reviewer tier with allowIm=false, so a
    // DM-targeted reviewer capability fires the DM-specific CHANNEL_NOT_ENABLED
    // copy.
    const decision = evaluateCapability({
      config,
      userId: 'UREVIEW',
      channelId: 'D-UREVIEW',
      channelType: 'im',
      capability: 'submit_pr_review',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.denyReason).toBe('CHANNEL_NOT_ENABLED');
    expect(decision.reason).toBe("Sorry, DMs aren't enabled for your role. Please contact an admin.");
  });

  it('evaluateCapability and evaluateAccess agree for the canonical intent→capability path', () => {
    // Behavior parity: for every WorkflowIntent, evaluateCapability(intentToCapability(i))
    // must return the same `allowed` + `denyReason` as evaluateAccess(resolveRequiredAccessLevel(i)).
    const intents: WorkflowIntent[] = [
      'PR_REVIEW',
      'IMPLEMENTATION',
      'INVESTIGATION',
      'DEPLOY',
      'DEV_ASSIST',
      'INFORMATIONAL',
      'CONVERSATIONAL',
    ];
    const cases: Array<{ userId: string; channelId: string; channelType?: string }> = [
      { userId: 'UVIEWER', channelId: 'C-VIEW' },
      { userId: 'UREVIEW', channelId: 'C-REVIEW' },
      { userId: 'UBUILDER', channelId: 'C-BUILD' },
      { userId: 'UADMIN', channelId: 'C-ADMIN' },
      { userId: 'UNOBODY', channelId: 'C-VIEW' },
    ];
    const config = makeConfig();
    for (const intent of intents) {
      for (const c of cases) {
        const viaTier = evaluateAccess({
          config,
          userId: c.userId,
          channelId: c.channelId,
          channelType: c.channelType,
          requiredLevel: resolveRequiredAccessLevel(intent),
        });
        const viaCapability = evaluateCapability({
          config,
          userId: c.userId,
          channelId: c.channelId,
          channelType: c.channelType,
          capability: intentToCapability(intent),
        });
        expect({
          intent,
          user: c.userId,
          channel: c.channelId,
          allowed: viaCapability.allowed,
          denyReason: viaCapability.denyReason,
        }).toEqual({
          intent,
          user: c.userId,
          channel: c.channelId,
          allowed: viaTier.allowed,
          denyReason: viaTier.denyReason,
        });
      }
    }
  });
});

describe('capability-bundles read path (D3)', () => {
  it('evaluateCapability reads from config.bundles directly (no legacy AccessControlConfig needed)', () => {
    // Synthesize a config with ONLY `bundles` populated — no `accessControl` field.
    // Proves the bundle read path is independent of the legacy shape.
    const baseConfigWithBundles: AppConfig = {
      platformPolicy: 'macos_only',
      bundleTargets: ['app', 'dmg'],
      ownerSlackUserIds: ['UOWNER1'],
      coreDevSlackUserIds: ['UOWNER1'],
      botUserId: 'UBOT1',
      slackBotToken: 'xoxb-test',
      slackAppToken: 'xapp-test',
      bugsAndUpdatesChannelId: 'C-BUILD',
      allowedChannelsForBugFix: ['C-BUILD'],
      repoPaths: {
        newtonWeb: '/Users/dipesh/code/newton-web',
        newtonApi: '/Users/dipesh/code/newton-api',
      },
      unknownTaskPolicy: 'desktop_only',
      uncertainRepoPolicy: 'desktop_only',
      unmappedPrRepoPolicy: 'desktop_only',
      maxConcurrentJobs: 2,
      repoClassifierThreshold: 0.75,
      allowedPrOrg: 'Newton-School',
      multiAgentEnabled: false,
      agentBackend: 'codex',
      prReviewTimeoutMs: 120_000,
      bugFixTimeoutMs: 120_000,
      pmTaskTimeoutMs: 120_000,
      // Intentionally NO accessControl field.
      bundles: [
        {
          name: 'reviewer',
          manualUserIds: 'UONLYREVIEW',
          resolvedUserIds: ['UONLYREVIEW'],
          capabilities: ['query_codebase', 'submit_pr_review', 'comment_pr', 'investigate'],
          allowedChannelIds: ['C-REVIEW'],
          allowIm: false,
          allowMpim: false,
        },
      ],
    };

    // User in the reviewer bundle, in the right channel, requesting a capability the bundle grants.
    const allowedDecision = evaluateCapability({
      config: baseConfigWithBundles,
      userId: 'UONLYREVIEW',
      channelId: 'C-REVIEW',
      capability: 'submit_pr_review',
    });
    expect(allowedDecision.allowed).toBe(true);
    expect(allowedDecision.ownerBypass).toBe(false);
    expect(allowedDecision.matchedGroups).toEqual(['reviewer']);

    // Same user, same channel, but a capability the reviewer bundle doesn't grant.
    const insufficientDecision = evaluateCapability({
      config: baseConfigWithBundles,
      userId: 'UONLYREVIEW',
      channelId: 'C-REVIEW',
      capability: 'deploy_prod',
    });
    expect(insufficientDecision.allowed).toBe(false);
    expect(insufficientDecision.denyReason).toBe('INSUFFICIENT_ROLE');

    // Same user, capability the bundle grants, but a channel the bundle isn't enabled in.
    const wrongChannelDecision = evaluateCapability({
      config: baseConfigWithBundles,
      userId: 'UONLYREVIEW',
      channelId: 'C-OTHER',
      capability: 'submit_pr_review',
    });
    expect(wrongChannelDecision.allowed).toBe(false);
    expect(wrongChannelDecision.denyReason).toBe('CHANNEL_NOT_ENABLED');

    // Owner bypass still fires even though there's no owner bundle defined.
    const ownerDecision = evaluateCapability({
      config: baseConfigWithBundles,
      userId: 'UOWNER1',
      channelId: 'C-ANYTHING',
      capability: 'deploy_prod',
    });
    expect(ownerDecision.allowed).toBe(true);
    expect(ownerDecision.ownerBypass).toBe(true);

    // User in zero bundles → NOT_ON_ACCESS_LIST.
    const noBundleDecision = evaluateCapability({
      config: baseConfigWithBundles,
      userId: 'UNOBODY',
      channelId: 'C-REVIEW',
      capability: 'submit_pr_review',
    });
    expect(noBundleDecision.allowed).toBe(false);
    expect(noBundleDecision.denyReason).toBe('NOT_ON_ACCESS_LIST');
  });

  it('AccessDecision.userGroups / matchedGroups carry bundle names matching legacy tier identifiers', () => {
    // Router logs these fields (`taskRouter.ts:250-258`). Bundle names == legacy
    // tier names during the migration, so log output stays identical.
    const config = makeConfig();
    const decision = evaluateCapability({
      config,
      userId: 'UADMIN',
      channelId: 'C-ADMIN',
      capability: 'deploy_prod',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.userGroups).toContain('admin');
    expect(decision.matchedGroups).toContain('admin');
  });

  it('evaluateAccess reads the bundles, not the legacy groups, so Settings edits reach the router', () => {
    const config = makeConfig({ ownerSlackUserIds: [] });
    // Settings moved the builder bundle to someone new; the legacy groups still list UBUILDER.
    config.bundles = hydrateBundleUserIds(
      (config.bundles ?? []).map(bundle => (bundle.name === 'builder' ? { ...bundle, manualUserIds: 'UNEW' } : bundle)),
      [],
    );
    expect(config.accessControl?.groups.builder.resolvedUserIds).toEqual(['UBUILDER']);

    const ask = (userId: string) =>
      evaluateAccess({ config, userId, channelId: 'C-BUILD', requiredLevel: 'builder' }).allowed;
    expect(ask('UNEW')).toBe(true);
    expect(ask('UBUILDER')).toBe(false);
  });
});
