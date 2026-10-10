import { describe, expect, it } from 'vitest';
import { intentToCapability, resolveRequiredAccessLevel, workflowSideEffect } from '../src/access/control.js';
import { RUNNABLE_INTENTS, TOOLS, toolForIntent } from '../src/router/toolRegistry.js';
import type { WorkflowIntent } from '../src/types/contracts.js';

// What the three hand-written switches in access/control.ts returned before
// they were replaced by the registry (issue #456). This table is the contract:
// moving to the registry must not change who may do what.
const BEFORE: Record<WorkflowIntent, [capability: string, level: string, sideEffect: string]> = {
  PR_REVIEW: ['submit_pr_review', 'reviewer', 'mutating'],
  IMPLEMENTATION: ['start_implementation', 'builder', 'mutating'],
  OWNER_AUTOPILOT: ['start_implementation', 'builder', 'mutating'],
  WEBAPP_QA: ['start_implementation', 'builder', 'answer'],
  INVESTIGATION: ['investigate', 'viewer', 'answer'],
  DEPLOY: ['deploy_prod', 'admin', 'mutating'],
  DEV_ASSIST: ['dev_assist', 'admin', 'answer'],
  INFORMATIONAL: ['query_codebase', 'viewer', 'answer'],
  CONVERSATIONAL: ['chat', 'viewer', 'chat'],
  MINIOG_DOSSIER: ['miniog_dossier_self', 'viewer', 'answer'],
  NONE: ['query_codebase', 'viewer', 'none'],
  UNKNOWN: ['query_codebase', 'viewer', 'answer'],
};

describe('tool registry keeps the access rules it replaced', () => {
  it.each(Object.entries(BEFORE) as [WorkflowIntent, [string, string, string]][])(
    '%s',
    (intent, [capability, level, sideEffect]) => {
      expect(intentToCapability(intent)).toBe(capability);
      expect(resolveRequiredAccessLevel(intent)).toBe(level);
      expect(workflowSideEffect(intent)).toBe(sideEffect);
    },
  );
});

describe('tool registry', () => {
  it('gives every intent to at most one tool', () => {
    const claimed = TOOLS.flatMap(tool => tool.intents);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('has unique tool ids and a description for each', () => {
    expect(new Set(TOOLS.map(tool => tool.id)).size).toBe(TOOLS.length);
    for (const tool of TOOLS) expect(tool.description.length).toBeGreaterThan(10);
  });

  it('names no tool for UNKNOWN', () => {
    expect(toolForIntent('UNKNOWN')).toBeUndefined();
    expect(toolForIntent('PR_REVIEW')?.id).toBe('review_pr');
    expect(toolForIntent('OWNER_AUTOPILOT')?.id).toBe('change_code');
  });

  it('marks only the production deploy as irreversible', () => {
    expect(TOOLS.filter(tool => tool.irreversible).map(tool => tool.id)).toEqual(['deploy']);
  });

  it('never lets the model pick an irreversible tool, or one reached by exact syntax', () => {
    const selectable = TOOLS.filter(tool => tool.routerSelectable).map(tool => tool.id);
    expect(selectable).toEqual(['review_pr', 'change_code', 'investigate', 'answer', 'chat', 'stay_silent']);
    expect(TOOLS.filter(tool => tool.irreversible && tool.routerSelectable)).toEqual([]);
  });

  it('lists the intents that have a workflow to run: all but NONE and UNKNOWN', () => {
    expect([...RUNNABLE_INTENTS].sort()).toEqual(
      [
        'CONVERSATIONAL',
        'DEPLOY',
        'DEV_ASSIST',
        'IMPLEMENTATION',
        'INFORMATIONAL',
        'INVESTIGATION',
        'MINIOG_DOSSIER',
        'OWNER_AUTOPILOT',
        'PR_REVIEW',
        'WEBAPP_QA',
      ].sort(),
    );
  });
});
