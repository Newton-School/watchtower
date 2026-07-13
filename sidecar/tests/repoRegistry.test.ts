import { describe, expect, it } from 'vitest';
import {
  REPO_KEYS,
  REPO_REGISTRY,
  RepoNotConfiguredError,
  describeEnabledRepos,
  enabledRepoKeys,
  enabledRepoPaths,
  guardrailBlockFor,
  isRepoEnabled,
  qaCaveatBlockFor,
  repoKeyFromGithubRepoName,
  repoPathOrNull,
  resolveRepoPath,
} from '../src/repos/registry.js';
import type { AppConfig } from '../src/types/contracts.js';

function configWith(repoPaths: AppConfig['repoPaths']): AppConfig {
  return { repoPaths } as AppConfig;
}

const TWO_REPO_CONFIG = configWith({ newtonWeb: '/mini-og/newton-web', newtonApi: '/mini-og/newton-api' });
const THREE_REPO_CONFIG = configWith({
  newtonWeb: '/mini-og/newton-web',
  newtonApi: '/mini-og/newton-api',
  newtonMarketingWeb: '/mini-og/newton-marketing-web',
});

describe('REPO_REGISTRY', () => {
  it('has a descriptor for every key, and each descriptor round-trips its key', () => {
    for (const key of REPO_KEYS) {
      expect(REPO_REGISTRY[key].key).toBe(key);
      expect(REPO_REGISTRY[key].githubSlug).toContain(key);
      expect(REPO_REGISTRY[key].description.length).toBeGreaterThan(0);
    }
  });

  it('marks only the marketing repo optional', () => {
    expect(REPO_REGISTRY['newton-web'].required).toBe(true);
    expect(REPO_REGISTRY['newton-api'].required).toBe(true);
    expect(REPO_REGISTRY['newton-marketing-web'].required).toBe(false);
  });
});

describe('enabled-repo gating', () => {
  it('excludes the marketing repo when its path is not configured', () => {
    expect(enabledRepoKeys(TWO_REPO_CONFIG)).toEqual(['newton-web', 'newton-api']);
    expect(isRepoEnabled(TWO_REPO_CONFIG, 'newton-marketing-web')).toBe(false);
    expect(repoPathOrNull(TWO_REPO_CONFIG, 'newton-marketing-web')).toBeNull();
  });

  it('includes the marketing repo when configured', () => {
    expect(enabledRepoKeys(THREE_REPO_CONFIG)).toEqual(['newton-web', 'newton-api', 'newton-marketing-web']);
    expect(enabledRepoPaths(THREE_REPO_CONFIG)).toContainEqual({
      key: 'newton-marketing-web',
      path: '/mini-og/newton-marketing-web',
    });
  });

  it('treats a blank path as not configured', () => {
    const config = configWith({ newtonWeb: '/w', newtonApi: '/a', newtonMarketingWeb: '   ' });
    expect(isRepoEnabled(config, 'newton-marketing-web')).toBe(false);
  });

  it('resolveRepoPath throws a typed error for an unconfigured repo', () => {
    expect(() => resolveRepoPath(TWO_REPO_CONFIG, 'newton-marketing-web')).toThrow(RepoNotConfiguredError);
    expect(() => resolveRepoPath(TWO_REPO_CONFIG, 'newton-marketing-web')).toThrow('newton_marketing_web_path');
    expect(resolveRepoPath(THREE_REPO_CONFIG, 'newton-marketing-web')).toBe('/mini-og/newton-marketing-web');
  });
});

describe('repoKeyFromGithubRepoName', () => {
  it('maps known repo names, case-insensitively', () => {
    expect(repoKeyFromGithubRepoName('newton-web')).toBe('newton-web');
    expect(repoKeyFromGithubRepoName('Newton-Marketing-Web')).toBe('newton-marketing-web');
  });

  it('returns null for unknown repos', () => {
    expect(repoKeyFromGithubRepoName('newton-mobile')).toBeNull();
    // The marketing slug must never fuzzy-match the newton-web key.
    expect(repoKeyFromGithubRepoName('newton-web-legacy')).toBeNull();
  });
});

describe('prompt blocks', () => {
  it('renders marketing guardrails with the load-bearing rules', () => {
    const block = guardrailBlockFor('newton-marketing-web');
    expect(block).toContain('worker/**');
    expect(block).toContain('.github/workflows/**');
    expect(block).toContain('NO test suite');
    expect(block).toContain('override any prior habits');
  });

  it('renders marketing QA caveats', () => {
    const block = qaCaveatBlockFor('newton-marketing-web');
    expect(block).toContain('401');
    expect(block).toContain('-temp');
    expect(block).toContain('worker/paths.js');
  });

  it('renders empty blocks for repos without guardrails', () => {
    expect(guardrailBlockFor('newton-web')).toBe('');
    expect(qaCaveatBlockFor('newton-api')).toBe('');
  });

  it('describeEnabledRepos lists only configured repos', () => {
    const two = describeEnabledRepos(TWO_REPO_CONFIG);
    expect(two).toContain('newton-web:');
    expect(two).not.toContain('newton-marketing-web:');
    const three = describeEnabledRepos(THREE_REPO_CONFIG);
    expect(three).toContain('newton-marketing-web:');
  });
});
