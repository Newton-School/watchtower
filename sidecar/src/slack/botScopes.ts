import type { WebClient } from '@slack/web-api';

/**
 * What the installed bot token is actually allowed to do.
 *
 * A scope ticked in the Slack app's config is not granted until the app is
 * reinstalled to the workspace, and nothing fails loudly in between: for a
 * month every attachment download was a 403 and every upload a
 * `missing_scope`, visible only in job logs (issue #433). `auth.test` returns
 * the granted scopes in a response header, so the sidecar can say so at
 * startup instead of one failed request at a time.
 */

export interface FeatureScope {
  scope: string;
  /** What stops working without it, as a sentence for the owner. */
  breaks: string;
}

/** Scopes whose absence breaks a feature without an error the requester would see. */
export const FEATURE_SCOPES: FeatureScope[] = [
  { scope: 'files:read', breaks: 'screenshots and files people attach cannot be opened' },
  { scope: 'files:write', breaks: 'files cannot be attached to replies' },
];

export interface BotScopeStatus {
  granted: string[];
  missing: FeatureScope[];
}

/** Sidecar-state key holding the missing set the owner was last told about. */
export const NOTIFIED_MISSING_SCOPES_KEY = 'slack_missing_scopes_notified';

class BotScopes {
  private status: BotScopeStatus | undefined;

  /**
   * Ask Slack which scopes the token carries. Returns undefined, and keeps the
   * previous answer, when the call fails or Slack sends no scope header: an
   * unknown is never treated as "missing".
   */
  async refresh(slack: WebClient): Promise<BotScopeStatus | undefined> {
    try {
      const response = await slack.auth.test();
      const granted = response.response_metadata?.scopes;
      if (!Array.isArray(granted) || granted.length === 0) {
        return undefined;
      }
      this.status = { granted, missing: FEATURE_SCOPES.filter(feature => !granted.includes(feature.scope)) };
      return this.status;
    } catch {
      return undefined;
    }
  }

  /** True only when the last successful check showed the scope absent. */
  knownMissing(scope: string): boolean {
    return this.status?.missing.some(feature => feature.scope === scope) ?? false;
  }

  current(): BotScopeStatus | undefined {
    return this.status;
  }

  /** Test hook: pretend a check returned these scopes (or forget the last check). */
  setForTest(granted: string[] | undefined): void {
    this.status = granted
      ? { granted, missing: FEATURE_SCOPES.filter(feature => !granted.includes(feature.scope)) }
      : undefined;
  }
}

export const botScopes = new BotScopes();

/**
 * The desktop notice for a set of missing scopes, or undefined when the owner
 * has already been told about exactly this set. The app restarts on every
 * release, and a reinstall can wait days on a workspace admin: one notice per
 * change, not one per start.
 */
export function missingScopesNotice(
  status: BotScopeStatus,
  lastNotified: string | undefined,
): { title: string; body: string; fingerprint: string } | undefined {
  const fingerprint = status.missing
    .map(feature => feature.scope)
    .sort()
    .join(',');
  if (!fingerprint || fingerprint === (lastNotified ?? '')) {
    return undefined;
  }
  const lines = status.missing.map(feature => `${feature.scope}: ${feature.breaks}`);
  return {
    title: 'miniOG Slack app is missing permissions',
    body: `${lines.join('. ')}. Reinstall the app to the workspace to grant them.`,
    fingerprint,
  };
}
