import type { JobCostSummary, JobLogRecord } from '../../types/contracts.js';

/** `m:ss` offset from the first log line, or `+m:ss` past an hour. */
function formatOffset(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

function parseData(log: JobLogRecord): Record<string, unknown> | undefined {
  if (!log.dataJson) return undefined;
  try {
    const parsed = JSON.parse(log.dataJson);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Render one log line as `kind` + `detail`, where `kind` is a short left column.
 * Tool events get their own kinds so skills, MCP calls, and subagents stand out
 * from ordinary file reads at a glance.
 */
function describeLog(log: JobLogRecord): { kind: string; detail: string } {
  if (log.stage === 'agent.tool.use') {
    const data = parseData(log);
    const tool = typeof data?.tool === 'string' ? data.tool : 'tool';
    const detail = typeof data?.detail === 'string' ? data.detail : '';

    const mcp = tool.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
    if (mcp) return { kind: 'mcp', detail: `${mcp[1]}.${mcp[2]}` };
    if (tool === 'Skill') return { kind: 'skill', detail };
    if (tool === 'Agent' || tool === 'Task') return { kind: 'agent', detail };
    return { kind: tool.toLowerCase(), detail };
  }

  if (log.stage === 'agent.message') {
    const text = log.message.replace(/\s+/g, ' ').trim();
    return { kind: 'note', detail: text.length > 90 ? `${text.slice(0, 90)}…` : text };
  }

  return { kind: log.stage, detail: log.message.replace(/\s+/g, ' ').trim() };
}

interface TraceRow {
  offsetMs: number;
  kind: string;
  detail: string;
  level: JobLogRecord['level'];
  count: number;
}

/**
 * Render a job's `job_logs` trail as a readable timeline.
 *
 * The Slack status line is ephemeral — it is gone the moment miniOG posts its
 * answer — so this is the durable record of what actually happened during a
 * run. Consecutive identical entries collapse (`read ×14`) so a loop of file
 * reads does not bury the interesting steps.
 */
export function formatJobTrace(params: { jobId: string; logs: JobLogRecord[]; cost?: JobCostSummary }): string {
  const { jobId, logs, cost } = params;
  if (logs.length === 0) return `No trace logs found for job ${jobId}.`;

  const t0 = Date.parse(logs[0].createdAt);
  const rows: TraceRow[] = [];

  for (const log of logs) {
    const { kind, detail } = describeLog(log);
    const previous = rows[rows.length - 1];
    // Collapse an immediately repeated identical entry into a count.
    if (previous && previous.kind === kind && previous.detail === detail && previous.level === log.level) {
      previous.count += 1;
      continue;
    }
    const parsed = Date.parse(log.createdAt);
    rows.push({
      offsetMs: Number.isNaN(parsed) || Number.isNaN(t0) ? 0 : parsed - t0,
      kind,
      detail,
      level: log.level,
      count: 1,
    });
  }

  const kindWidth = Math.min(24, Math.max(...rows.map(row => row.kind.length)));
  const lines = rows.map(row => {
    const marker = row.level === 'ERROR' ? '!' : row.level === 'WARN' ? '~' : ' ';
    const repeat = row.count > 1 ? ` ×${row.count}` : '';
    const kind = row.kind.padEnd(kindWidth);
    return `${formatOffset(row.offsetMs)} ${marker} ${kind}  ${row.detail}${repeat}`.trimEnd();
  });

  const totalSteps = logs.length;
  const footerParts = [`${totalSteps} step${totalSteps === 1 ? '' : 's'}`];
  if (cost && cost.callCount > 0) {
    footerParts.push(`${cost.callCount} agent call${cost.callCount === 1 ? '' : 's'}`);
    footerParts.push(formatDuration(cost.totalDurationMs));
    if (cost.totalCostUsd > 0) footerParts.push(`$${cost.totalCostUsd.toFixed(2)}`);
  }

  return [`Trace for job ${jobId}:`, '```', ...lines, '```', `_${footerParts.join(' · ')}_`].join('\n');
}
