import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { UxMetrics, UxStepTiming, UxWindow } from '../types';
import { GlowCard } from '../components/GlowCard';
import { PageIntro } from '../components/primitives';
import { formatDurationMs, humanizeToken } from '../lib/formatters';

const TOOL_LABELS: Record<string, string> = {
  INFORMATIONAL: 'Lookup',
  PR_REVIEW: 'PR review',
  IMPLEMENTATION: 'Change run',
  QUICK_ACTION: 'Quick action (merge, close, sync)',
  INVESTIGATION: 'Investigation',
  CONVERSATIONAL: 'Chat',
  DEPLOY: 'Prod deploy',
  STAGING_DEPLOY: 'Staging deploy',
  UNKNOWN: 'Router reply',
  OWNER_AUTOPILOT: 'Owner tag',
  NONE: 'Nothing run',
  DEV_ASSIST: 'Dev assist',
  MINIOG_DOSSIER: 'Dossier',
  WEBAPP_QA: 'Browser QA',
};

function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? humanizeToken(tool.toLowerCase());
}

function channelLabel(row: { key: string; label: string }): string {
  if (row.label && row.label !== row.key) return `#${row.label}`;
  if (row.key.startsWith('D')) return 'Direct message';
  if (row.key.startsWith('G')) return 'Group message';
  return row.key;
}

function duration(ms: number | null): string {
  return ms === null ? '—' : formatDurationMs(ms);
}

function oneDecimal(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(1);
}

/** The change in a median time, as a badge: shorter is better. */
function TimeChange({ now, before }: { now: number | null; before: number | null }) {
  if (now === null || before === null || before <= 0) return <span className="muted">—</span>;
  const change = (now - before) / before;
  if (Math.abs(change) < 0.05) return <span className="status-badge info">same</span>;
  const pct = `${Math.round(Math.abs(change) * 100)}%`;
  return change < 0 ? (
    <span className="status-badge success">{pct} faster</span>
  ) : (
    <span className="status-badge failed">{pct} slower</span>
  );
}

function stepPair(current: UxWindow, previous: UxWindow): Array<{ now: UxStepTiming; before?: UxStepTiming }> {
  return current.steps.map(now => ({ now, before: previous.steps.find(step => step.key === now.key) }));
}

function countsByKey(rows: Array<{ key: string; count: number }>): Map<string, number> {
  return new Map(rows.map(row => [row.key, row.count]));
}

export function UxMetricsPage() {
  const [metrics, setMetrics] = useState<UxMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<UxMetrics>('get_ux_metrics', { untilIso: new Date().toISOString() })
      .then(data => {
        if (!cancelled) setMetrics(data);
      })
      .catch(err => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  const current = metrics?.current;
  const previous = metrics?.previous;
  const empty = Boolean(current && previous && current.jobs === 0 && previous.jobs === 0);

  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Experience"
        title="UX metrics"
        description="How a request feels from the asker's side: the last 7 days beside the 7 before, from this Mac's job store."
      />

      <GlowCard>
        <section className="surface-card">
          <div className="section-head">
            <div className="section-heading-copy">
              <div className="section-title-row">
                <h2>Time from the ask</h2>
              </div>
              <p className="muted">
                Median and slowest-10% time from the Slack message to each step, over the runs that reached it. The
                approval wait runs from the plan to the first approval.
              </p>
            </div>
            <div className="performance-range-toggle">
              <button type="button" className="range-button" onClick={load} disabled={loading}>
                {loading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
          </div>

          {error ? <div className="inline-error-banner">{error}</div> : null}
          {loading && !metrics ? <p className="muted">Loading…</p> : null}
          {empty ? (
            <p className="muted">
              No requests in the last 14 days yet. The numbers show up here once miniOG has handled some.
            </p>
          ) : null}

          {current && previous && !empty ? (
            <div className="cost-table-scroll">
              <table className="cost-table">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th className="num">Median</th>
                    <th className="num">Slowest 10%</th>
                    <th className="num">Runs</th>
                    <th className="num">Previous 7 days</th>
                    <th className="num">Runs (previous 7 days)</th>
                    <th>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {stepPair(current, previous).map(({ now, before }) => (
                    <tr key={now.key}>
                      <td>{now.label}</td>
                      <td className="num">{duration(now.medianMs)}</td>
                      <td className="num">{duration(now.p90Ms)}</td>
                      <td className="num">{now.count}</td>
                      <td className="num">{duration(before?.medianMs ?? null)}</td>
                      <td className="num">{before?.count ?? 0}</td>
                      <td>
                        <TimeChange now={now.medianMs} before={before?.medianMs ?? null} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </GlowCard>

      {current && previous && !empty ? (
        <GlowCard>
          <section className="surface-card">
            <div className="section-head">
              <div className="section-heading-copy">
                <div className="section-title-row">
                  <h2>Human effort per change run</h2>
                </div>
                <p className="muted">
                  Answers a person had to give: plan approvals and confirmations, changes asked for, clarifying
                  questions, answers given from the app. Each reply counts once.
                </p>
              </div>
            </div>
            <div className="detail-grid">
              <div>
                <span>Last 7 days, average</span>
                <strong>{oneDecimal(current.interventions.meanPerRun)}</strong>
              </div>
              <div>
                <span>Last 7 days, median</span>
                <strong>{oneDecimal(current.interventions.medianPerRun)}</strong>
              </div>
              <div>
                <span>Change runs</span>
                <strong>{current.interventions.changeRuns}</strong>
              </div>
              <div>
                <span>Previous 7 days, average</span>
                <strong>{oneDecimal(previous.interventions.meanPerRun)}</strong>
              </div>
              <div>
                <span>Previous 7 days, change runs</span>
                <strong>{previous.interventions.changeRuns}</strong>
              </div>
            </div>
          </section>
        </GlowCard>
      ) : null}

      {current && previous && !empty ? (
        <GlowCard>
          <section className="surface-card">
            <div className="section-head">
              <div className="section-heading-copy">
                <div className="section-title-row">
                  <h2>Messages miniOG posted per run</h2>
                </div>
                <p className="muted">From the captured threads, counting runs that posted at least one message.</p>
              </div>
            </div>
            <MessagesTable current={current} previous={previous} />
          </section>
        </GlowCard>
      ) : null}

      {current && previous && !empty ? (
        <GlowCard>
          <section className="surface-card">
            <div className="section-head">
              <div className="section-heading-copy">
                <div className="section-title-row">
                  <h2>Failures by tool</h2>
                </div>
                <p className="muted">Runs that ended failed, which the asker sees as an error reply.</p>
              </div>
            </div>
            <OutcomesTable current={current} previous={previous} />
          </section>
        </GlowCard>
      ) : null}

      {current && previous && !empty ? (
        <GlowCard>
          <section className="surface-card">
            <div className="section-head">
              <div className="section-heading-copy">
                <div className="section-title-row">
                  <h2>Where people ask</h2>
                  <span className="section-count">{current.jobs}</span>
                </div>
                <p className="muted">Requests by channel and by the tool that ran, the last 7 days and the 7 before.</p>
              </div>
            </div>
            <CountsTable
              heading="Channel"
              current={current.byChannel}
              previous={previous.byChannel}
              label={channelLabel}
            />
            <CountsTable
              heading="Tool"
              current={current.byTool}
              previous={previous.byTool}
              label={row => toolLabel(row.key)}
            />
          </section>
        </GlowCard>
      ) : null}

      {metrics && !empty ? (
        <p className="muted">
          Merged and live only count what miniOG itself merged or deployed; merges done on GitHub don&apos;t show here.
        </p>
      ) : null}
    </div>
  );
}

function MessagesTable({ current, previous }: { current: UxWindow; previous: UxWindow }) {
  if (current.messages.length === 0) return <p className="muted">No captured messages in the last 7 days.</p>;
  const before = new Map(previous.messages.map(row => [row.tool, row]));
  return (
    <div className="cost-table-scroll">
      <table className="cost-table">
        <thead>
          <tr>
            <th>Tool</th>
            <th className="num">Average</th>
            <th className="num">Median</th>
            <th className="num">Runs</th>
            <th className="num">Previous 7 days average</th>
          </tr>
        </thead>
        <tbody>
          {current.messages.map(row => (
            <tr key={row.tool}>
              <td>{toolLabel(row.tool)}</td>
              <td className="num">{row.mean.toFixed(1)}</td>
              <td className="num">{row.median.toFixed(1)}</td>
              <td className="num">{row.runs}</td>
              <td className="num">{oneDecimal(before.get(row.tool)?.mean)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutcomesTable({ current, previous }: { current: UxWindow; previous: UxWindow }) {
  if (current.outcomes.length === 0) return <p className="muted">No runs in the last 7 days.</p>;
  const before = new Map(previous.outcomes.map(row => [row.tool, row]));
  return (
    <div className="cost-table-scroll">
      <table className="cost-table">
        <thead>
          <tr>
            <th>Tool</th>
            <th className="num">Runs</th>
            <th className="num">Failed</th>
            <th className="num">Stopped</th>
            <th className="num">Previous 7 days failed</th>
          </tr>
        </thead>
        <tbody>
          {current.outcomes.map(row => {
            const last = before.get(row.tool);
            return (
              <tr key={row.tool}>
                <td>{toolLabel(row.tool)}</td>
                <td className="num">{row.jobs}</td>
                <td className="num">{row.failed}</td>
                <td className="num">{row.cancelled}</td>
                <td className="num">{last ? `${last.failed} of ${last.jobs}` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CountsTable({
  heading,
  current,
  previous,
  label,
}: {
  heading: string;
  current: Array<{ key: string; label: string; count: number }>;
  previous: Array<{ key: string; label: string; count: number }>;
  label: (row: { key: string; label: string }) => string;
}) {
  if (current.length === 0) return null;
  const before = countsByKey(previous);
  return (
    <div className="cost-table-scroll">
      <table className="cost-table">
        <thead>
          <tr>
            <th>{heading}</th>
            <th className="num">Last 7 days</th>
            <th className="num">Previous 7 days</th>
          </tr>
        </thead>
        <tbody>
          {current.map(row => (
            <tr key={row.key}>
              <td>{label(row)}</td>
              <td className="num">{row.count}</td>
              <td className="num">{before.get(row.key) ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
