import { describe, expect, it } from 'vitest';
import {
  composeChangeReply,
  requesterIsEngineer,
  sanitizeRequesterSummary,
} from '../src/workflows/shared/changeReply.js';
import type { AppConfig } from '../src/types/contracts.js';

const config = { ownerSlackUserIds: ['UOWNER'], coreDevSlackUserIds: ['UADMIN'] } as unknown as AppConfig;

const summary =
  'Swapped the header counsellor phone number on three pages, plus the v5 nav because the worker serves that body at the DS-v2 URL for ~50% of traffic. Gates green: npm run lint (0 warnings), typecheck, build. Left EXTERNAL_LINKS.counsellorPhone alone. Dev server pid 43469 needs a manual kill.';
const requesterSummary =
  'The "Give us a call" number on the three course pages you listed now reads +91 74117 82198. The old number no longer appears on those pages. Please check the call button on mobile once the change is live.';

describe('requesterIsEngineer', () => {
  it('is true for the owner, an admin, or a dossier that says dev', () => {
    expect(requesterIsEngineer({ userId: 'UOWNER', config })).toBe(true);
    expect(requesterIsEngineer({ userId: 'UADMIN', config })).toBe(true);
    expect(requesterIsEngineer({ userId: 'UDEV', config, role: 'dev' })).toBe(true);
  });

  it('is false for a PM, a designer, ops, an analyst, or someone with no role', () => {
    for (const role of ['pm', 'designer', 'ops', 'analyst', undefined] as const) {
      expect(requesterIsEngineer({ userId: 'UPM', config, role })).toBe(false);
    }
  });
});

describe('sanitizeRequesterSummary', () => {
  it('keeps bullets and line breaks, trims, and caps the length', () => {
    expect(sanitizeRequesterSummary('- The number now reads +91 74117 82198.\r\n\n\n- Check the call button.\n')).toBe(
      '- The number now reads +91 74117 82198.\n\n- Check the call button.',
    );
    expect(sanitizeRequesterSummary('x'.repeat(800))).toHaveLength(700);
  });
});

describe('composeChangeReply', () => {
  it('gives a non-engineer the plain summary, the PR, and a pointer to the engineering notes', () => {
    const text = composeChangeReply({
      summary,
      requesterSummary,
      engineerReads: false,
      prUrl: 'https://github.com/Newton-School/newton-marketing-web/pull/1407',
      externalBlock: '',
    });
    expect(text).toBe(
      `${requesterSummary}\nhttps://github.com/Newton-School/newton-marketing-web/pull/1407\n_The engineering notes are in the PR._`,
    );
    expect(text).not.toContain('pid 43469');
  });

  it('gives an engineer the full account', () => {
    const text = composeChangeReply({
      summary,
      requesterSummary,
      engineerReads: true,
      prUrl: 'https://github.com/x/y/pull/1',
      externalBlock: '',
    });
    expect(text).toBe(`${summary}\nhttps://github.com/x/y/pull/1`);
  });

  it('falls back to the full account when the coder wrote no requester summary', () => {
    const text = composeChangeReply({
      summary,
      requesterSummary: '',
      engineerReads: false,
      prUrl: 'https://github.com/x/y/pull/1',
      externalBlock: '',
    });
    expect(text).toBe(`${summary}\nhttps://github.com/x/y/pull/1`);
  });

  it('says so when a PR was expected and could not be opened', () => {
    const text = composeChangeReply({
      summary,
      requesterSummary,
      engineerReads: false,
      prUrl: '',
      externalBlock: '',
      prFailed: true,
    });
    expect(text).toBe(
      `${requesterSummary}\n:warning: I could not open a pull request for this, so nothing is live yet. An admin needs to look at the branch.`,
    );
  });

  it('keeps the changes-outside-the-repo block and skips the pointer when there is no PR', () => {
    const text = composeChangeReply({
      summary,
      requesterSummary,
      engineerReads: false,
      prUrl: '',
      externalBlock: '\n\n*Changed outside the repo:*\n• *Newton admin, question 1042:* uploaded 3 images',
    });
    expect(text).toBe(
      `${requesterSummary}\n\n*Changed outside the repo:*\n• *Newton admin, question 1042:* uploaded 3 images`,
    );
  });
});
