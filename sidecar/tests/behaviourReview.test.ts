import { afterEach, describe, expect, it } from 'vitest';
import {
  BEHAVIOUR_PROMPT_MARKER,
  MAX_CHECKLIST_ROWS,
  behaviourGaps,
  behaviourSlackLine,
  buildBehaviourLensPrompt,
  changesUserBehaviour,
  findFigmaLinks,
  findTicketKeys,
  findingKey,
  findingRows,
  planBehaviourReview,
  readBehaviourReport,
  renderBehaviourSection,
  withRefutedGapsCleared,
  type BehaviourPromptParams,
  type BehaviourReport,
} from '../src/agentic/behaviourReview.js';
import { BEHAVIOUR_ECHO_LINES, dropBehaviourEchoes, dropBehaviourNoteEchoes } from '../src/agentic/prReviewAgent.js';
import type { AppConfig } from '../src/types/contracts.js';

const config = {} as AppConfig;

describe('which Jira tickets a PR names', () => {
  it('reads a key from the title, the branch and the description, most trusted first', () => {
    expect(
      findTicketKeys({
        title: 'NMW-412: empty cart state',
        headRef: 'feat/nmw-413-cart',
        body: 'Follows NMW-400.',
      }),
    ).toEqual(['NMW-412', 'NMW-413', 'NMW-400']);
  });

  it('puts a Jira link first, wherever it is', () => {
    expect(
      findTicketKeys({
        title: 'Cart fixes',
        body: 'See NMW-1 and https://newton.atlassian.net/browse/NMW-77 for the spec.',
      }),
    ).toEqual(['NMW-77', 'NMW-1']);
  });

  it('does not take "UTF-8" or "SHA-256" for a ticket', () => {
    expect(findTicketKeys({ title: 'Read files as UTF-8, hash with SHA-256', body: 'ISO-8601 dates' })).toEqual([]);
  });

  it('names each ticket once, and at most three', () => {
    expect(findTicketKeys({ title: 'AB-1 AB-1', body: 'AB-2 AB-3 AB-4' })).toEqual(['AB-1', 'AB-2', 'AB-3']);
  });

  it('finds nothing when there is nothing', () => {
    expect(findTicketKeys({})).toEqual([]);
  });
});

describe('which Figma designs a PR links', () => {
  it('finds design, file and prototype links, once each, without trailing punctuation', () => {
    const body =
      'Design: https://www.figma.com/design/abc123/Cart?node-id=1-2. Proto: https://figma.com/proto/xyz/Flow ' +
      'again https://www.figma.com/design/abc123/Cart?node-id=1-2.';
    expect(findFigmaLinks(body)).toEqual([
      'https://www.figma.com/design/abc123/Cart?node-id=1-2',
      'https://figma.com/proto/xyz/Flow',
    ]);
  });
});

describe('whether a PR changes what a user sees or gets', () => {
  it('is false for docs, tests, CI, dependencies and tooling only', () => {
    expect(
      changesUserBehaviour([
        'README.md',
        'docs/setup.md',
        '.github/workflows/ci.yml',
        'package.json',
        'package-lock.json',
        'src/__tests__/cart.test.tsx',
        'src/cart/Cart.stories.tsx',
        'api/tests/test_cart.py',
        'eslint.config.js',
        'tsconfig.json',
        'Dockerfile',
      ]),
    ).toBe(false);
  });

  it('is true as soon as one app file changes', () => {
    expect(changesUserBehaviour(['README.md', 'src/cart/Cart.tsx'])).toBe(true);
    expect(changesUserBehaviour(['courses/views.py'])).toBe(true);
  });
});

describe('planning the behaviour check', () => {
  afterEach(() => {
    delete process.env.WATCHTOWER_PR_REVIEW_BEHAVIOUR;
  });

  it('runs for app code, with the tickets and designs the PR names', () => {
    const plan = planBehaviourReview({
      config,
      prMeta: { title: 'NMW-9 cart', body: 'https://www.figma.com/design/abc/Cart' },
      changedPaths: ['src/Cart.tsx'],
      orchestrated: true,
    });
    expect(plan).toMatchObject({
      kind: 'run',
      ticketKeys: ['NMW-9'],
      figmaLinks: ['https://www.figma.com/design/abc/Cart'],
    });
  });

  it('says why it is not run when nothing a user sees changed', () => {
    expect(planBehaviourReview({ config, prMeta: {}, changedPaths: ['README.md'], orchestrated: true })).toMatchObject({
      kind: 'skip',
    });
  });

  it('is off in the classic review and when switched off', () => {
    expect(planBehaviourReview({ config, prMeta: {}, changedPaths: ['src/a.ts'], orchestrated: false })).toEqual({
      kind: 'off',
    });
    process.env.WATCHTOWER_PR_REVIEW_BEHAVIOUR = '0';
    expect(planBehaviourReview({ config, prMeta: {}, changedPaths: ['src/a.ts'], orchestrated: true })).toEqual({
      kind: 'off',
    });
  });
});

function promptParams(overrides: Partial<BehaviourPromptParams> = {}): BehaviourPromptParams {
  return {
    recallBlock: '',
    prContext: {
      url: 'https://github.com/Newton-School/newton-web/pull/1',
      owner: 'Newton-School',
      repo: 'newton-web',
      number: 1,
    },
    prMeta: { title: 'NMW-9 cart', body: 'Adds the empty cart state.' },
    policyBlock: '- none',
    threadContext: '(none)',
    diff: '+added',
    ticketKeys: ['NMW-9'],
    figmaLinks: [],
    jiraAvailable: true,
    oneShot: false,
    ...overrides,
  };
}

describe('the behaviour check prompt', () => {
  it('names itself, the tickets to read and how, and that Jira is read-only', () => {
    const prompt = buildBehaviourLensPrompt(promptParams());
    expect(prompt).toContain(BEHAVIOUR_PROMPT_MARKER);
    expect(prompt).toContain('The PR names NMW-9');
    expect(prompt).toContain('mcp__atlassian__get-jira-issue');
    expect(prompt).toContain('never create, change or delete a ticket');
    expect(prompt).toContain('You must NOT post anything to GitHub or Slack');
    expect(prompt).toContain('"checklist"');
    expect(prompt).toContain('+added');
  });

  it('works from the description when no ticket is named', () => {
    const prompt = buildBehaviourLensPrompt(promptParams({ ticketKeys: [] }));
    expect(prompt).toContain('name no Jira ticket');
    expect(prompt).toContain('work from the PR description');
  });

  it('says Jira cannot be read when the server is not there, and never tells it to call the tools', () => {
    const prompt = buildBehaviourLensPrompt(promptParams({ jiraAvailable: false }));
    expect(prompt).toContain('Jira cannot be read in this run');
    expect(prompt).not.toContain('mcp__atlassian__get-jira-issue');
  });

  it('says a linked design is not checked rather than guessed at', () => {
    const prompt = buildBehaviourLensPrompt(promptParams({ figmaLinks: ['https://www.figma.com/design/abc/Cart'] }));
    expect(prompt).toContain('You cannot open Figma in this run');
    expect(prompt).toContain('design not checked against Figma');
  });

  it('says when the description is empty', () => {
    expect(buildBehaviourLensPrompt(promptParams({ prMeta: { title: 'Cart' } }))).toContain('Description: (none)');
  });
});

const CHECKED: Record<string, unknown> = {
  specSource: 'jira',
  ticketsRead: ['nmw-9'],
  specNote: '',
  checklist: [
    {
      expectation: 'A learner with an empty cart sees "Browse courses"',
      source: 'NMW-9',
      status: 'done',
      where: 'src/Cart.tsx:12',
    },
    {
      expectation: 'Only leads | admins can clear a cart',
      source: 'NMW-9',
      status: 'partial',
      note: 'The API allows anyone.',
    },
    { expectation: 'Cart count updates after removal', source: 'PR description', status: 'missing' },
    { expectation: 'Something odd', source: 'NMW-9', status: 'bogus' },
    { source: 'NMW-9', status: 'done' },
  ],
  questions: ['Should guests see the cart?', '', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'],
};

describe('reading the behaviour report', () => {
  it('keeps the rows, marks an unknown status unclear, and drops a row with no expectation', () => {
    const report = readBehaviourReport(CHECKED);
    expect(report.status).toBe('checked');
    if (report.status !== 'checked') return;
    expect(report.ticketsRead).toEqual(['NMW-9']);
    expect(report.checklist.map(row => row.status)).toEqual(['done', 'partial', 'missing', 'unclear']);
    expect(report.questions).toHaveLength(5);
    expect(behaviourGaps(report)).toBe(2);
  });

  it('is a failure, not an empty table, when no checklist came back', () => {
    expect(readBehaviourReport({ findings: [] })).toEqual({
      status: 'failed',
      reason: 'The behaviour check returned no checklist.',
    });
  });

  it('does not claim Jira when no ticket was read', () => {
    const report = readBehaviourReport({ ...CHECKED, ticketsRead: [] });
    expect(report.status === 'checked' && report.specSource).toBe('description');
  });
});

describe('a gap the verifier refuted', () => {
  const finding = { file: 'src/Cart.tsx', line: 30, message: 'NMW-9 says the count updates. It does not.' };

  it('is shown as unclear, not missing', () => {
    const report = readBehaviourReport(CHECKED);
    const rows = findingRows({ findings: [{ ...finding, item: 3 }] });
    const cleared = withRefutedGapsCleared(report, rows, [finding], []);
    expect(cleared.status === 'checked' && cleared.checklist[2]).toMatchObject({
      status: 'unclear',
      note: 'A second check of the code did not confirm this gap.',
    });
  });

  it('stays a gap when another finding on the same row was confirmed', () => {
    const other = { file: 'src/Cart.tsx', line: 31, message: 'The badge is not refreshed.' };
    const report = readBehaviourReport(CHECKED);
    const rows = findingRows({
      findings: [
        { ...finding, item: 3 },
        { ...other, item: 3 },
      ],
    });
    const cleared = withRefutedGapsCleared(report, rows, [finding], [other]);
    expect(cleared.status === 'checked' && cleared.checklist[2].status).toBe('missing');
  });

  it('matches findings by file, line and message', () => {
    expect(findingKey(finding)).toBe(findingKey({ ...finding }));
    expect(findingKey(finding)).not.toBe(findingKey({ ...finding, line: 31 }));
  });
});

describe('the behaviour check in the review body', () => {
  it('is a table, with the sources, a status per row, where, and the questions', () => {
    const section = renderBehaviourSection(readBehaviourReport(CHECKED));
    expect(section).toContain('### Behaviour check');
    expect(section).toContain('Checked against NMW-9 (Jira) and the PR description.');
    expect(section).toContain('| # | Expected behaviour | Source | Status | Where |');
    expect(section).toContain(
      '| 1 | A learner with an empty cart sees "Browse courses" | NMW-9 | ✅ Done | `src/Cart.tsx:12` |',
    );
    // A pipe in the text does not break the row.
    expect(section).toContain('Only leads \\| admins can clear a cart');
    expect(section).toContain('⚠️ Partial: The API allows anyone.');
    expect(section).toContain('| 3 | Cart count updates after removal | PR description | ❌ Missing | — |');
    expect(section).toContain('Questions for the author:\n- Should guests see the cart?');
  });

  it('says when it was checked against the description or the title only', () => {
    const fromDescription = renderBehaviourSection(readBehaviourReport({ ...CHECKED, ticketsRead: [] }));
    expect(fromDescription).toContain('No Jira ticket found: checked against the PR description.');
    const fromTitle = renderBehaviourSection(readBehaviourReport({ ...CHECKED, specSource: 'title', ticketsRead: [] }));
    expect(fromTitle).toContain('No Jira ticket and no PR description: checked against the PR title only.');
  });

  it(`shows at most ${MAX_CHECKLIST_ROWS} rows and says how many were left out`, () => {
    const checklist = Array.from({ length: MAX_CHECKLIST_ROWS + 2 }, (_, i) => ({
      expectation: `Row ${i + 1}`,
      source: 'NMW-9',
      status: 'done',
    }));
    const section = renderBehaviourSection(readBehaviourReport({ ...CHECKED, checklist }));
    expect(section).toContain(`| ${MAX_CHECKLIST_ROWS} | Row ${MAX_CHECKLIST_ROWS} |`);
    expect(section).not.toContain(`Row ${MAX_CHECKLIST_ROWS + 1} |`);
    expect(section).toContain('…and 2 more row(s) left out.');
  });

  it('says why there is no table when the check did not run or did not finish', () => {
    expect(renderBehaviourSection({ status: 'skipped', reason: 'Docs only.' })).toBe(
      '### Behaviour check\nNot run. Docs only.',
    );
    expect(renderBehaviourSection({ status: 'failed', reason: 'Timed out.' })).toBe(
      '### Behaviour check\nDid not finish. Timed out.',
    );
  });
});

describe('the behaviour check in Slack', () => {
  it('is one line with the counts', () => {
    expect(behaviourSlackLine(readBehaviourReport(CHECKED))).toBe(
      'Behaviour check against NMW-9: 1 of 4 done, 1 partial, 1 missing, 1 unclear, 5 question(s) for the author.',
    );
  });

  it('is nothing when the check was not run, and a short line when it did not finish', () => {
    const skipped: BehaviourReport = { status: 'skipped', reason: 'Docs only.' };
    expect(behaviourSlackLine(skipped)).toBeUndefined();
    expect(behaviourSlackLine(undefined)).toBeUndefined();
    expect(behaviourSlackLine({ status: 'failed', reason: 'x' })).toContain('did not finish');
  });
});

describe('a behaviour finding that repeats another pass', () => {
  // The first live review: both behaviour findings were the lead reviewer's, reworded, 2 and 24 lines away.
  const LEAD =
    'The cart list can be stale. A learner can empty the cart in another tab, and this row still shows the old count. When the admin then selects Clear Cart, the endpoint looks up only carts with items, so the call fails with a not found error and the dialog closes.';
  const ECHO =
    'The dialog treats every failure of the clear call the same way: it shows the server error, closes and reloads. When the learner already emptied the cart in another tab, the endpoint returns a not found error, so the admin is told the cart does not exist.';
  const OTHER =
    'The new discount badge renders the percentage with two decimals, while the design and the ticket show a whole number, so learners see 12.50% off instead of 13% off.';
  const base = { severity: 'medium' as const, category: 'flow', file: 'src/cart/ClearDialog.tsx' };
  const lead = { ...base, lens: 'reviewer' as const, line: 51, message: LEAD };

  it('is dropped when it is near in the same file and says much the same; the other pass keeps its finding', () => {
    const echo = { ...base, lens: 'behaviour' as const, line: 49, message: ECHO };
    expect(dropBehaviourEchoes([lead, echo])).toEqual({ kept: [lead], dropped: 1 });
  });

  it('is kept when it is about something else, in another file, or far away', () => {
    const different = { ...base, lens: 'behaviour' as const, line: 50, message: OTHER };
    const elsewhere = { ...base, lens: 'behaviour' as const, file: 'src/cart/Badge.tsx', line: 51, message: ECHO };
    const far = { ...base, lens: 'behaviour' as const, line: 51 + BEHAVIOUR_ECHO_LINES + 1, message: ECHO };
    const findings = [lead, different, elsewhere, far];
    expect(dropBehaviourEchoes(findings)).toEqual({ kept: findings, dropped: 0 });
  });

  it("never drops another pass's finding for a behaviour one", () => {
    const security = { ...base, lens: 'security' as const, line: 49, message: ECHO };
    expect(dropBehaviourEchoes([lead, security]).dropped).toBe(0);
  });

  it('drops a behaviour note another pass already wrote, and keeps the rest', () => {
    const notes = {
      reviewer: [
        'This PR depends on the API change in the backend PR, which is still open. Without it, Clear Cart fails with a validation error. Merge and deploy the API PR first.',
      ],
      behaviour: [
        'Clear Cart needs the API change in the backend PR, and that PR is still open. If this PR ships first, every Clear Cart fails with a validation error. Merge and deploy the API PR first.',
        'The empty state copy differs from the ticket: it says Browse courses where the ticket says Explore programs.',
      ],
    };
    expect(dropBehaviourNoteEchoes(notes)).toBe(1);
    expect(notes.behaviour).toEqual([
      'The empty state copy differs from the ticket: it says Browse courses where the ticket says Explore programs.',
    ]);
  });
});

describe('the behaviour check after its first live review', () => {
  it('leaves missing tests and style to the lead reviewer', () => {
    expect(buildBehaviourLensPrompt(promptParams())).toContain(
      'Do not report missing tests, naming, style or code structure: the lead reviewer covers them.',
    );
  });

  it('keeps the file name and line of a long path, clipping from the left', () => {
    const where = 'src/containers/mentor/progression-tracker/components/StudentPresenceModal/index.js:51';
    const section = renderBehaviourSection(
      readBehaviourReport({ ...CHECKED, checklist: [{ expectation: 'x', source: 'NMW-9', status: 'done', where }] }),
    );
    expect(section).toContain('/StudentPresenceModal/index.js:51` |');
    expect(section).toContain('`…');
    expect(section).not.toContain('`src/containers/mentor');
  });
});
