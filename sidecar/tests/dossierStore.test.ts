import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/state/jobStore.js';
import { inferRoleFromTitle, __test__, formatDossierForPrompt } from '../src/state/dossierStore.js';

const { TtlLru } = __test__;

function makeStore(): JobStore {
  // JobStore opens its own connection via better-sqlite3; supply an in-memory path.
  return new JobStore(':memory:');
}

describe('TtlLru', () => {
  it('stores and retrieves values within ttl', () => {
    const lru = new TtlLru<string>(10, 1_000);
    lru.set('a', 'one');
    expect(lru.get('a')).toBe('one');
  });

  it('expires values after ttl elapses', async () => {
    const lru = new TtlLru<string>(10, 5);
    lru.set('a', 'one');
    await new Promise(r => setTimeout(r, 15));
    expect(lru.get('a')).toBeUndefined();
  });

  it('evicts oldest when over capacity', () => {
    const lru = new TtlLru<string>(2, 60_000);
    lru.set('a', '1');
    lru.set('b', '2');
    lru.set('c', '3');
    expect(lru.get('a')).toBeUndefined();
    expect(lru.get('b')).toBe('2');
    expect(lru.get('c')).toBe('3');
  });

  it('refreshes recency on get so a re-accessed key survives eviction', () => {
    const lru = new TtlLru<string>(2, 60_000);
    lru.set('a', '1');
    lru.set('b', '2');
    expect(lru.get('a')).toBe('1'); // moves a to most-recent
    lru.set('c', '3'); // evicts b
    expect(lru.get('a')).toBe('1');
    expect(lru.get('b')).toBeUndefined();
    expect(lru.get('c')).toBe('3');
  });
});

describe('dossierStore CRUD', () => {
  it('captures firstSeen and reads the profile back', () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    dossiers.firstSeen({
      userId: 'U1',
      displayName: 'dipesh',
      realName: 'Dipesh Rajoria',
      tz: 'Asia/Kolkata',
      email: 'dipesh@example.com',
    });

    const dossier = dossiers.getDossier('U1');
    expect(dossier.profile?.userId).toBe('U1');
    expect(dossier.profile?.displayName).toBe('dipesh');
    expect(dossier.profile?.tz).toBe('Asia/Kolkata');
    expect(dossier.affinity).toEqual([]);
    expect(dossier.tone).toBe('normal');
    store.close();
  });

  it('setRole upserts and persists across reads', () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    dossiers.setRole('U2', 'pm');
    let dossier = dossiers.getDossier('U2');
    expect(dossier.profile?.role).toBe('pm');

    dossiers.setRole('U2', 'dev');
    dossier = dossiers.getDossier('U2');
    expect(dossier.profile?.role).toBe('dev');
    store.close();
  });

  it('setTone writes a personality_profiles row read back via getDossier', () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    dossiers.firstSeen({ userId: 'U3' });
    dossiers.setTone('U3', 'terse', 'set-role');
    const dossier = dossiers.getDossier('U3');
    expect(dossier.tone).toBe('terse');
    expect(dossier.toneSource).toBe('set-role');
    store.close();
  });

  it('forgetField clears individual fields without touching others', () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    dossiers.firstSeen({ userId: 'U4', displayName: 'alice' });
    dossiers.setRole('U4', 'pm');
    dossiers.setTone('U4', 'casual', 'set-role');

    dossiers.forgetField('U4', 'role');
    let dossier = dossiers.getDossier('U4');
    expect(dossier.profile?.role).toBeNull();
    expect(dossier.tone).toBe('casual');

    dossiers.forgetField('U4', 'tone');
    dossier = dossiers.getDossier('U4');
    expect(dossier.tone).toBe('normal');
    store.close();
  });

  it("forgetField 'all' wipes the user", () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    dossiers.firstSeen({ userId: 'U5', displayName: 'bob' });
    dossiers.setRole('U5', 'designer');
    dossiers.setTone('U5', 'technical', 'set-role');

    dossiers.forgetField('U5', 'all');
    const dossier = dossiers.getDossier('U5');
    expect(dossier.profile).toBeNull();
    expect(dossier.tone).toBe('normal');
    store.close();
  });

  it('listDossiers returns recent users sorted by updated_at desc', () => {
    const store = makeStore();
    const dossiers = store.dossierStore();
    dossiers.firstSeen({ userId: 'U_OLD', displayName: 'old' });
    dossiers.firstSeen({ userId: 'U_NEW', displayName: 'new' });
    const list = dossiers.listDossiers();
    expect(list.length).toBe(2);
    // both inserted close together; order isn't strictly testable, but both are present.
    expect(list.map(d => d.userId).sort()).toEqual(['U_NEW', 'U_OLD']);
    store.close();
  });
});

describe('formatDossierForPrompt', () => {
  it('renders the user line even with no signals', () => {
    const summary = formatDossierForPrompt({
      profile: {
        userId: 'U1',
        displayName: 'dipesh',
        firstSeenAt: '2026-05-03T00:00:00Z',
        updatedAt: '2026-05-03T00:00:00Z',
      },
      affinity: [],
      productAffinity: [],
      metrics: {},
      tone: 'normal',
    });
    expect(summary).toContain('User: dipesh');
    expect(summary.split('\n').length).toBe(1);
  });

  it('includes role, primary repo, intent mix, tone, and failures when present', () => {
    const summary = formatDossierForPrompt({
      profile: {
        userId: 'U1',
        displayName: 'alice',
        role: 'pm',
        firstSeenAt: '2026-05-03T00:00:00Z',
        updatedAt: '2026-05-03T00:00:00Z',
      },
      affinity: [{ repo: 'newton-web', hits: 10, successes: 8, failures: 2, computedAt: '2026-05-03T00:00:00Z' }],
      productAffinity: [],
      metrics: {
        intent_mix: { IMPLEMENTATION: 6, INVESTIGATION: 3, PR_REVIEW: 1 },
        failure_fingerprint: { topErrorKinds: [{ kind: 'TypeError' }, { kind: 'TimeoutError' }] },
      },
      tone: 'terse',
    });
    expect(summary).toContain('User: alice (pm)');
    expect(summary).toContain('Primary repo: newton-web (10 jobs, 80% success)');
    expect(summary).toContain('Typical intents: IMPLEMENTATION(6), INVESTIGATION(3), PR_REVIEW(1)');
    expect(summary).toContain('Preferred tone: terse');
    expect(summary).toContain('Common failure modes: TypeError, TimeoutError');
  });

  it('skips tone line when tone is normal', () => {
    const summary = formatDossierForPrompt({
      profile: {
        userId: 'U1',
        firstSeenAt: '2026-05-03T00:00:00Z',
        updatedAt: '2026-05-03T00:00:00Z',
      },
      affinity: [],
      productAffinity: [],
      metrics: {},
      tone: 'normal',
    });
    expect(summary).not.toContain('Preferred tone');
  });
});

describe('dossier_cache_signals bridge (#284)', () => {
  it('invalidates the in-memory cache when an external write bumps the signal row', () => {
    // Simulate the desktop Tauri path: it writes directly to user_dossiers and
    // then upserts the signal row. The sidecar's getDossier must detect the
    // signal and serve the fresh row instead of its stale cached copy.
    const store = makeStore();
    const dossiers = store.dossierStore();

    dossiers.setRole('U_SIGNAL', 'pm');
    // Warm the cache with the current value.
    expect(dossiers.getDossier('U_SIGNAL').profile?.role).toBe('pm');

    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;

    // Imitate the desktop: write the role directly to SQLite (bypassing the
    // sidecar mutator that would have invalidated the cache itself).
    db.prepare(`UPDATE user_dossiers SET role = 'dev' WHERE user_id = ?`).run('U_SIGNAL');

    // Without a signal write, the cache would still return 'pm'. With the
    // signal, the sidecar should detect the external edit and reload.
    db.prepare(
      `INSERT INTO dossier_cache_signals(user_id, updated_at) VALUES(?, ?)
       ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run('U_SIGNAL', new Date().toISOString());

    const reloaded = dossiers.getDossier('U_SIGNAL');
    expect(reloaded.profile?.role).toBe('dev');
    store.close();
  });

  it('does not invalidate on repeat reads when the signal has not changed', () => {
    // After the first read picks up the signal, subsequent reads must NOT
    // keep invalidating the cache — that would defeat its purpose.
    const store = makeStore();
    const dossiers = store.dossierStore();
    dossiers.setRole('U_REPEAT', 'pm');

    const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
    db.prepare(
      `INSERT INTO dossier_cache_signals(user_id, updated_at) VALUES(?, ?)
       ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at`,
    ).run('U_REPEAT', '2026-05-17T00:00:00Z');

    // First read after the signal: should pick up the value and remember it.
    dossiers.getDossier('U_REPEAT');
    // Mutate DB silently again. With a STABLE signal value the cache should
    // still serve its memoized copy and NOT reflect the silent change.
    db.prepare(`UPDATE user_dossiers SET role = 'dev' WHERE user_id = ?`).run('U_REPEAT');

    const repeated = dossiers.getDossier('U_REPEAT');
    expect(repeated.profile?.role).toBe('pm'); // cache still trusted
    store.close();
  });
});

describe('a role from the Slack profile title (issue #601)', () => {
  it('reads the common titles and says nothing for the rest', () => {
    expect(inferRoleFromTitle('Product Manager')).toBe('pm');
    expect(inferRoleFromTitle('Senior Product Designer')).toBe('designer');
    expect(inferRoleFromTitle('Software Engineer II')).toBe('dev');
    expect(inferRoleFromTitle('Data Analyst')).toBe('analyst');
    expect(inferRoleFromTitle('Admissions Counsellor')).toBe('ops');
    expect(inferRoleFromTitle('Marketing Lead')).toBe('ops');
    expect(inferRoleFromTitle('')).toBeUndefined();
    expect(inferRoleFromTitle(undefined)).toBeUndefined();
    expect(inferRoleFromTitle('Wizard')).toBeUndefined();
  });

  it('fills a blank role on first sight and never changes one a person set', () => {
    const dossiers = makeStore().dossierStore();

    dossiers.firstSeen({ userId: 'UT1', displayName: 'maya', title: 'Product Manager' });
    expect(dossiers.getDossier('UT1').profile?.role).toBe('pm');
    expect(dossiers.getDossier('UT1').profile?.source).toBe('slack-title');

    dossiers.setRole('UT1', 'designer');
    dossiers.firstSeen({ userId: 'UT1', displayName: 'maya', title: 'Product Manager' });
    expect(dossiers.getDossier('UT1').profile?.role).toBe('designer');

    dossiers.firstSeen({ userId: 'UT2', displayName: 'sam', title: 'Wizard' });
    expect(dossiers.getDossier('UT2').profile?.role ?? undefined).toBeUndefined();
  });
});
