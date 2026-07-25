import { describe, expect, it } from 'vitest';
import { formatJobTrace } from '../src/workflows/shared/traceFormatter.js';
import type { JobCostSummary, JobLogRecord } from '../src/types/contracts.js';

const T0 = Date.parse('2026-07-25T10:00:00.000Z');

/** Build a job_logs row `secondsIn` seconds after the trace start. */
function log(secondsIn: number, stage: string, message: string, extra: Partial<JobLogRecord> = {}): JobLogRecord {
  return {
    id: secondsIn,
    jobId: 'job-1',
    level: 'INFO',
    stage,
    message,
    createdAt: new Date(T0 + secondsIn * 1000).toISOString(),
    ...extra,
  };
}

/** Build an `agent.tool.use` row the stream decoder would have written. */
function toolLog(secondsIn: number, tool: string, detail?: string): JobLogRecord {
  return log(secondsIn, 'agent.tool.use', `Agent used ${tool}.`, {
    dataJson: JSON.stringify(detail === undefined ? { tool } : { tool, detail }),
  });
}

describe('formatJobTrace', () => {
  it('reports nothing to show for an empty trail', () => {
    expect(formatJobTrace({ jobId: 'job-1', logs: [] })).toBe('No trace logs found for job job-1.');
  });

  it('renders elapsed offsets relative to the first line', () => {
    const text = formatJobTrace({
      jobId: 'job-1',
      logs: [log(0, 'job.created', 'Created job record.'), log(75, 'agentic.done', 'Agent finished.')],
    });

    expect(text).toContain('00:00');
    expect(text).toContain('01:15');
  });

  it('gives skills, MCP calls and subagents their own kinds', () => {
    const text = formatJobTrace({
      jobId: 'job-1',
      logs: [
        toolLog(0, 'Skill', 'rca-job'),
        toolLog(3, 'mcp__metabase__execute_query'),
        toolLog(9, 'Agent', 'Explore'),
        toolLog(12, 'Read', 'src/a.ts'),
      ],
    });

    expect(text).toContain('skill');
    expect(text).toContain('rca-job');
    expect(text).toContain('mcp');
    expect(text).toContain('metabase.execute_query');
    expect(text).toContain('agent');
    expect(text).toContain('Explore');
    expect(text).toContain('read');
  });

  it('collapses consecutive identical entries into a count', () => {
    const logs = [toolLog(0, 'Read', 'src/a.ts'), toolLog(1, 'Read', 'src/a.ts'), toolLog(2, 'Read', 'src/a.ts')];
    const text = formatJobTrace({ jobId: 'job-1', logs });

    expect(text).toContain('×3');
    // One collapsed row, not three.
    expect(text.split('\n').filter(line => line.includes('src/a.ts'))).toHaveLength(1);
  });

  it('does not collapse across different details', () => {
    const text = formatJobTrace({
      jobId: 'job-1',
      logs: [toolLog(0, 'Read', 'a.ts'), toolLog(1, 'Read', 'b.ts')],
    });

    expect(text).not.toContain('×');
    expect(text.split('\n').filter(line => line.includes('read'))).toHaveLength(2);
  });

  it('marks WARN and ERROR lines', () => {
    const text = formatJobTrace({
      jobId: 'job-1',
      logs: [
        log(0, 'qa.evidence.missing_scope', 'Missing files:write.', { level: 'ERROR' }),
        log(1, 'slack.status.disabled', 'Status off.', { level: 'WARN' }),
      ],
    });

    expect(text).toMatch(/00:00 ! /);
    expect(text).toMatch(/00:01 ~ /);
  });

  it('appends a cost footer when agent calls were recorded', () => {
    const cost: JobCostSummary = {
      jobId: 'job-1',
      totalCostUsd: 0.4123,
      totalDurationMs: 107_000,
      totalInputTokens: 1,
      totalOutputTokens: 1,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      callCount: 4,
      calls: [],
    };

    const text = formatJobTrace({ jobId: 'job-1', logs: [toolLog(0, 'Read', 'a.ts')], cost });
    expect(text).toContain('1 step');
    expect(text).toContain('4 agent calls');
    expect(text).toContain('1m47s');
    expect(text).toContain('$0.41');
  });

  it('omits the cost footer when no agent calls were recorded', () => {
    const text = formatJobTrace({ jobId: 'job-1', logs: [toolLog(0, 'Read', 'a.ts')] });
    expect(text).toContain('1 step');
    expect(text).not.toContain('agent call');
    expect(text).not.toContain('$');
  });

  it('survives malformed tool data without throwing', () => {
    const logs = [
      log(0, 'agent.tool.use', 'Agent used something.', { dataJson: 'not json' }),
      log(1, 'agent.tool.use', 'Agent used something.'),
    ];
    expect(() => formatJobTrace({ jobId: 'job-1', logs })).not.toThrow();
  });

  it('tolerates an unparseable timestamp', () => {
    const logs = [log(0, 'job.created', 'x', { createdAt: 'not-a-date' })];
    expect(() => formatJobTrace({ jobId: 'job-1', logs })).not.toThrow();
  });
});
