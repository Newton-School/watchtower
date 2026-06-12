import { describe, expect, it } from 'vitest';
import { diagnoseFailure } from '../src/learning/failureDoctor.js';

describe('failureDoctor', () => {
  it('diagnoses missing codex binary', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'OWNER_AUTOPILOT',
      message: 'Workflow failed after retries: Error: spawn codex ENOENT',
      logs: [],
    });

    expect(diagnosis?.errorKind).toBe('CODEX_BIN_NOT_FOUND');
    expect(diagnosis?.summary).toContain('Codex CLI');
  });

  it('diagnoses native module ABI mismatch', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'BUG_FIX',
      message: 'ERR_DLOPEN_FAILED',
      logs: [
        {
          stage: 'boot',
          message: 'better-sqlite3 was compiled against NODE_MODULE_VERSION 115',
          level: 'ERROR',
        },
      ],
    });

    expect(diagnosis?.errorKind).toBe('NATIVE_MODULE_ABI_MISMATCH');
  });

  it('surfaces verifier suggestions for pipeline critical findings', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'IMPLEMENTATION',
      message: 'Pipeline finished with status: aborted.',
      logs: [
        {
          stage: 'pipeline.abort',
          level: 'ERROR',
          message: 'Pipeline aborted due to critical finding from verifier.',
          data: {
            role: 'verifier',
            criticalFindings: [
              {
                severity: 'critical',
                category: 'process-failure',
                message: 'No planner output was provided.',
                suggestion: 'Ask the user for the console error and the failing network request.',
              },
              {
                severity: 'critical',
                category: 'missing-requirements',
                message: 'No acceptance criteria.',
                suggestion: 'Run the planner agent with debugging context before implementation.',
              },
            ],
          },
        },
      ],
    });

    expect(diagnosis?.errorKind).toBe('PIPELINE_CRITICAL_FINDING');
    expect(diagnosis?.summary).toContain('verifier');
    expect(diagnosis?.actions).toEqual([
      'Ask the user for the console error and the failing network request.',
      'Run the planner agent with debugging context before implementation.',
    ]);
  });

  it('falls back to generic actions when critical findings have no suggestions', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'IMPLEMENTATION',
      message: 'Pipeline finished with status: aborted.',
      logs: [
        {
          stage: 'pipeline.abort',
          level: 'ERROR',
          message: 'Pipeline aborted due to critical finding from reviewer.',
          data: {
            role: 'reviewer',
            criticalFindings: [{ severity: 'critical', message: 'Bad code' }],
          },
        },
      ],
    });

    expect(diagnosis?.errorKind).toBe('PIPELINE_CRITICAL_FINDING');
    expect(diagnosis?.actions[0]).toMatch(/Review the critical findings/);
  });

  it('returns undefined for unrecognized failures', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'PR_REVIEW',
      message: 'something unexpected but generic happened',
      logs: [],
    });

    expect(diagnosis).toBeUndefined();
  });

  it('does not classify github auth as failed for auth-resolved informational logs', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'OWNER_AUTOPILOT',
      message: 'Owner-autopilot workflow failed (exit=1).',
      logs: [
        {
          stage: 'owner_autopilot.github.auth_resolved',
          message: 'Resolved GitHub auth mode for owner-autopilot Codex execution.',
          level: 'INFO',
        },
      ],
    });

    expect(diagnosis?.errorKind).not.toBe('GITHUB_AUTH_OR_API');
  });

  it('diagnoses repeated codex output parse/schema failures', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'OWNER_AUTOPILOT',
      message: 'Owner-autopilot workflow failed (exit=1).',
      logs: [
        {
          stage: 'codex.output.parse_failed',
          message: 'Codex final output is not valid JSON.',
          level: 'WARN',
        },
        {
          stage: 'codex.output.parse_failed',
          message: 'Codex final output is not valid JSON.',
          level: 'WARN',
        },
      ],
    });

    expect(diagnosis?.errorKind).toBe('CODEX_OUTPUT_SCHEMA');
  });

  it('diagnoses a Claude usage-limit hit as USAGE_LIMIT (issue #342)', () => {
    const diagnosis = diagnoseFailure({
      workflow: 'IMPLEMENTATION',
      message: 'Paused on Claude usage limit (resets 9:40pm (Asia/Calcutta)).',
      logs: [
        {
          stage: 'pipeline.usage_limit',
          message: 'Claude usage limit hit during coder — aborting the pipeline (resets 9:40pm (Asia/Calcutta)).',
          level: 'ERROR',
          createdAt: '2026-06-12T16:03:56Z',
        } as never,
      ],
    });

    expect(diagnosis?.errorKind).toBe('USAGE_LIMIT');
    expect(diagnosis?.actions.join(' ')).toContain('resume');
  });
});
