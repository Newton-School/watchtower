/**
 * Environment that makes `git push` to GitHub fail for an agent (issue #730).
 *
 * A follow-up's coder works on an open PR's branch and must only commit:
 * miniOG pushes once the reviewer and the final check have passed. A prompt
 * alone can be ignored, so the coder's git also gets `pushInsteadOf` rules
 * (through `GIT_CONFIG_COUNT`, no config file written) that rewrite every
 * GitHub push URL to a `no-push://` scheme git has no helper for: the push
 * fails with "unable to find remote helper for 'no-push'". Fetches are
 * unaffected (`pushInsteadOf` applies to pushes only). Git skips these rules
 * for a remote with an explicit `pushurl`, which our clones never set.
 * runAgent merges these entries with the run's own (`mergeAgentEnv`, issue
 * #746): git matches `pushInsteadOf` against the remote's own URL before the
 * run's SSH-to-HTTPS `insteadOf`, so both forms of remote stay blocked. The
 * rules match text, so the explicit-port forms are listed too; a different
 * case (`GitHub.com`) can't be listed, but the run has GH_TOKEN anyway: this
 * stops a coder pushing by habit, not one set on getting round it.
 */
export const NO_PUSH_TO_GITHUB_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_COUNT: '5',
  GIT_CONFIG_KEY_0: 'url.no-push://.pushInsteadOf',
  GIT_CONFIG_VALUE_0: 'https://github.com/',
  GIT_CONFIG_KEY_1: 'url.no-push://.pushInsteadOf',
  GIT_CONFIG_VALUE_1: 'git@github.com:',
  GIT_CONFIG_KEY_2: 'url.no-push://.pushInsteadOf',
  GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
  GIT_CONFIG_KEY_3: 'url.no-push://.pushInsteadOf',
  GIT_CONFIG_VALUE_3: 'https://github.com:443/',
  GIT_CONFIG_KEY_4: 'url.no-push://.pushInsteadOf',
  GIT_CONFIG_VALUE_4: 'ssh://git@github.com:22/',
};
