import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  formatCostUsd,
  formatDurationSeconds,
  formatPercent,
  formatTokens,
  getPriorityTone,
  getStatusTone,
  humanizeMode,
  prettyJson,
} from '../lib/formatters';
import { Timestamp } from './Timestamp';
import type {
  ChannelHeat,
  DashboardMetrics,
  DashboardRecommendation,
  JobLogEntry,
  LearningInsights,
  PipelineRunData,
  RunSummary,
} from '../types';
import { GlowCard } from './GlowCard';

type SectionCardProps = {
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  count?: number | string;
  subtitle?: string;
  title: string;
};

export function PageIntro({
  eyebrow,
  title,
  description,
  actions,
}: {
  actions?: ReactNode;
  description: string;
  eyebrow: string;
  title: string;
}) {
  return (
    <header className="page-intro">
      <div className="page-intro-copy">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>

      <div className="page-intro-visual" aria-hidden="true">
        <span className="page-intro-ring page-intro-ring-outer" />
        <span className="page-intro-ring page-intro-ring-mid" />
        <span className="page-intro-ring page-intro-ring-inner" />
        <span className="page-intro-core" />
      </div>
    </header>
  );
}

export function SectionCard({ actions, children, className, count, subtitle, title }: SectionCardProps) {
  return (
    <GlowCard>
      <section className={className ? `surface-card ${className}` : 'surface-card'}>
        <div className="section-head">
          <div className="section-heading-copy">
            <div className="section-title-row">
              <h2>{title}</h2>
              {count !== undefined ? <span className="section-count">{count}</span> : null}
            </div>
            {subtitle ? <p className="muted">{subtitle}</p> : null}
          </div>

          {actions ? <div className="section-head-actions">{actions}</div> : null}
        </div>
        {children}
      </section>
    </GlowCard>
  );
}

export function MetricCard({
  className,
  detail,
  label,
  tone = 'neutral',
  value,
  valueTitle,
  variant = 'default',
}: {
  className?: string;
  detail?: string;
  label: string;
  tone?: 'accent' | 'danger' | 'neutral' | 'success' | 'warning';
  value: ReactNode;
  valueTitle?: string;
  variant?: 'compact' | 'default';
}) {
  return (
    <article
      className={
        className
          ? `metric-card metric-${tone} metric-${variant} ${className}`
          : `metric-card metric-${tone} metric-${variant}`
      }
    >
      <span className="metric-label">{label}</span>
      <strong className="metric-value" title={valueTitle}>
        {value}
      </strong>
      {detail ? <p className="metric-detail">{detail}</p> : null}
    </article>
  );
}

export function StatusBadge({ label, tone = 'info' }: { label: string; tone?: string }) {
  return <span className={`status-badge ${tone}`}>{label}</span>;
}

function parseSlackMarkdown(text: string): ReactNode[] {
  const result: ReactNode[] = [];
  let key = 0;

  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    if (li > 0) result.push(<br key={`br-${key++}`} />);
    const line = lines[li];

    // Tokenize inline patterns: *bold*, `code`, _italic_, URLs
    const regex = /(\*[^*]+\*|`[^`]+`|_[^_]+_|https?:\/\/[^\s<>]+)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(line)) !== null) {
      if (match.index > lastIndex) {
        result.push(line.slice(lastIndex, match.index));
      }

      const token = match[0];
      if (token.startsWith('http')) {
        result.push(
          <a key={`t-${key++}`} className="slack-md-link" href={token} target="_blank" rel="noopener noreferrer">
            {token}
          </a>,
        );
      } else if (token.startsWith('`')) {
        result.push(
          <code key={`t-${key++}`} className="slack-md-code">
            {token.slice(1, -1)}
          </code>,
        );
      } else if (token.startsWith('*')) {
        result.push(<strong key={`t-${key++}`}>{token.slice(1, -1)}</strong>);
      } else if (token.startsWith('_')) {
        result.push(
          <em key={`t-${key++}`} className="slack-md-em">
            {token.slice(1, -1)}
          </em>,
        );
      }

      lastIndex = match.index + token.length;
    }

    if (lastIndex < line.length) {
      result.push(line.slice(lastIndex));
    }
  }

  return result;
}

export function SlackMarkdown({ text }: { text: string }) {
  const nodes = useMemo(() => parseSlackMarkdown(text), [text]);
  return <>{nodes}</>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty-state">{children}</p>;
}

export function TabBar<T extends string>({
  onChange,
  tabs,
  value,
}: {
  onChange: (value: T) => void;
  tabs: Array<{ count?: number | string; label: string; value: T }>;
  value: T;
}) {
  return (
    <div className="tab-bar" role="tablist">
      {tabs.map(tab => (
        <button
          key={tab.value}
          className={tab.value === value ? 'tab-button active' : 'tab-button'}
          type="button"
          onClick={() => onChange(tab.value)}
        >
          <span>{tab.label}</span>
          {tab.count !== undefined ? <span className="tab-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function RunList({
  empty,
  onSelect,
  runs,
  selectedRunId,
}: {
  empty: string;
  onSelect?: (runId: string) => void;
  runs: RunSummary[];
  selectedRunId?: string | null;
}) {
  if (runs.length === 0) {
    return <EmptyState>{empty}</EmptyState>;
  }

  return (
    <ul className="run-list">
      {runs.map(run => {
        const selected = run.id === selectedRunId;
        return (
          <li key={run.id}>
            <button
              type="button"
              className={selected ? 'run-card selected' : 'run-card'}
              onClick={() => onSelect?.(run.id)}
            >
              <div className="run-card-top">
                <div className="run-card-copy">
                  <span className="run-card-workflow">{run.workflow.replaceAll('_', ' ')}</span>
                  <span className="run-card-title">{run.taskSummary}</span>
                </div>
                <StatusBadge label={run.status} tone={getStatusTone(run.status)} />
              </div>
              <div className="run-card-meta">
                <span>
                  Updated <Timestamp value={run.updatedAt} />
                </span>
              </div>
              {run.errorMessage ? <p className="run-card-error">{run.errorMessage}</p> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function RunInspector({
  logs,
  onReviewChanges: _onReviewChanges,
  run,
}: {
  logs: JobLogEntry[];
  onReviewChanges?: (runId: string) => void;
  run: RunSummary | null;
}) {
  if (!run) {
    return <EmptyState>Select a run to inspect its metadata and execution trace.</EmptyState>;
  }

  return (
    <div className="inspector-stack">
      <article className="surface-card detail-card">
        <div className="detail-header">
          <div className="detail-header-copy">
            <span className="eyebrow">{run.workflow.replaceAll('_', ' ')}</span>
            <h2>{run.taskSummary}</h2>
          </div>
          <StatusBadge label={run.status} tone={getStatusTone(run.status)} />
        </div>

        <div className="detail-grid">
          <div>
            <span>Job ID</span>
            <strong>{run.id}</strong>
          </div>
          <div>
            <span>Channel</span>
            <strong>{run.channelId}</strong>
          </div>
          <div>
            <span>Thread</span>
            <strong>{run.threadTs}</strong>
          </div>
          <div>
            <span>Created</span>
            <strong>
              <Timestamp value={run.createdAt} />
            </strong>
          </div>
          <div>
            <span>Updated</span>
            <strong>
              <Timestamp value={run.updatedAt} />
            </strong>
          </div>
          <div>
            <span>Trace Entries</span>
            <strong>{logs.length}</strong>
          </div>
        </div>

        {run.errorMessage ? (
          <div className="detail-error">
            <SlackMarkdown text={run.errorMessage} />
          </div>
        ) : null}

        {/*
         * Review Changes button is intentionally omitted: nothing in the
         * codebase calls JobStore.saveDiff(), so job_diffs is never
         * populated and ReviewPage hits a guaranteed no-diff dead-end.
         * Re-add this entry point once successful code-producing jobs
         * persist their diff.
         */}
      </article>

      <SectionCard title="Execution Trace" subtitle={`Persisted trace for ${run.id}`} count={logs.length}>
        <TraceList logs={logs} selectedRun={run} />
      </SectionCard>
    </div>
  );
}

export function TraceList({ logs, selectedRun }: { logs: JobLogEntry[]; selectedRun: RunSummary | null }) {
  if (!selectedRun) {
    return <EmptyState>Select a run from the list to inspect detailed step logs.</EmptyState>;
  }

  if (logs.length === 0) {
    return <EmptyState>No trace entries have been persisted for this run yet.</EmptyState>;
  }

  return (
    <ul className="trace-list">
      {logs.map(log => (
        <li key={log.id}>
          <div className="trace-top">
            <StatusBadge label={log.level} tone={getStatusTone(log.level)} />
            <span className="trace-stage">{log.stage}</span>
            <span className="trace-time">
              <Timestamp value={log.createdAt} />
            </span>
          </div>
          <div className="trace-message">
            <SlackMarkdown text={log.message} />
          </div>
          {log.dataJson ? <pre className="trace-data">{prettyJson(log.dataJson)}</pre> : null}
        </li>
      ))}
    </ul>
  );
}

export function LiveLogConsole({ lines }: { lines: Array<{ id: number; content: string }> }) {
  if (lines.length === 0) {
    return <EmptyState>Waiting for sidecar log output.</EmptyState>;
  }

  return (
    <div className="live-log-console" role="log" aria-live="polite">
      {lines.map(line => (
        <div key={line.id}>{line.content}</div>
      ))}
    </div>
  );
}

export function RecommendationList({
  empty,
  limit,
  recommendations,
}: {
  empty?: string;
  limit?: number;
  recommendations: DashboardRecommendation[];
}) {
  const items = limit ? recommendations.slice(0, limit) : recommendations;
  if (items.length === 0) {
    return <EmptyState>{empty ?? 'No recommendations generated yet.'}</EmptyState>;
  }

  return (
    <ul className="recommendation-list">
      {items.map(item => (
        <li key={item.id}>
          <div className="recommendation-top">
            <strong>{item.title}</strong>
            <StatusBadge label={item.priority} tone={getPriorityTone(item.priority)} />
          </div>
          <p className="recommendation-body">{item.detail}</p>
        </li>
      ))}
    </ul>
  );
}

export function PulseMetrics({ metrics }: { metrics: DashboardMetrics }) {
  return (
    <div className="pulse-grid">
      <MetricCard label="24h Success" value={`${metrics.successRate24h}%`} tone="success" variant="compact" />
      <MetricCard label="24h Runs" value={metrics.runs24h} variant="compact" />
      <MetricCard label="24h Failures" value={metrics.failedRuns24h} tone="danger" variant="compact" />
      <MetricCard
        label="Avg Resolution"
        value={formatDurationSeconds(metrics.avgResolutionSeconds24h)}
        variant="compact"
      />
      <MetricCard
        label="Catch-up Wins"
        value={metrics.catchupRecovered24h}
        tone={metrics.catchupRecovered24h > 0 ? 'accent' : 'neutral'}
        variant="compact"
      />
      <MetricCard
        label="Unknown 24h"
        value={metrics.unknownTasks24h}
        tone={metrics.unknownTasks24h > 0 ? 'warning' : 'neutral'}
        variant="compact"
      />
      <MetricCard
        label="Access Audits"
        value={metrics.accessAuditWouldDeny24h}
        tone={metrics.accessAuditWouldDeny24h > 0 ? 'warning' : 'neutral'}
        variant="compact"
      />
      <MetricCard
        label="Success Streak"
        value={metrics.successStreak}
        tone={metrics.successStreak > 0 ? 'success' : 'neutral'}
        variant="compact"
      />
      <MetricCard
        label="Chaos Index"
        value={metrics.chaosIndex}
        tone={metrics.chaosIndex > 0 ? 'warning' : 'neutral'}
        variant="compact"
      />
      <MetricCard
        label="24h Cost"
        value={formatCostUsd(metrics.cost24hUsd)}
        tone={metrics.cost24hUsd > 0 ? 'accent' : 'neutral'}
        variant="compact"
      />
      <MetricCard
        label="24h Tokens"
        value={`${formatTokens(metrics.tokensInput24h)} ↓ / ${formatTokens(metrics.tokensOutput24h)} ↑`}
        variant="compact"
      />
      <MetricCard
        label="Cache Hit"
        value={formatPercent(metrics.cacheHitRate24h)}
        tone={metrics.cacheHitRate24h > 0 ? 'success' : 'neutral'}
        variant="compact"
      />
      <MetricCard label="Avg Cost / Run" value={formatCostUsd(metrics.avgCostPerRunUsd)} variant="compact" />
    </div>
  );
}

export function ChannelHeatList({
  channels,
  empty,
  limit,
}: {
  channels: ChannelHeat[];
  empty?: string;
  limit?: number;
}) {
  const items = limit ? channels.slice(0, limit) : channels;
  if (items.length === 0) {
    return <EmptyState>{empty ?? 'No channel activity yet.'}</EmptyState>;
  }

  return (
    <ul className="channel-heat-list">
      {items.map(channel => (
        <li key={channel.channelId}>
          <strong className="channel-id">{channel.channelId}</strong>
          <div className="channel-runs">{channel.runs} runs</div>
          <StatusBadge label={`${channel.failures} failures`} tone={channel.failures > 0 ? 'warn' : 'success'} />
        </li>
      ))}
    </ul>
  );
}

export function LearningInsightsPanel({ learning }: { learning: LearningInsights }) {
  const dominantMode = humanizeMode(learning.dominantPersonalityMode);
  const topFailure =
    learning.topFailureKind === 'none' ? 'None' : `${learning.topFailureKind} (${learning.topFailureCount})`;

  return (
    <div className="learning-stack">
      <div className="learning-metrics learning-metrics-primary">
        <MetricCard label="Signals 24h" value={learning.signals24h} variant="compact" />
        <MetricCard
          label="Corrections Learned"
          value={learning.correctionsLearned}
          tone={learning.correctionsLearned > 0 ? 'accent' : 'neutral'}
          variant="compact"
        />
        <MetricCard
          label="Corrections Applied"
          value={learning.correctionsApplied24h}
          tone={learning.correctionsApplied24h > 0 ? 'success' : 'neutral'}
          variant="compact"
        />
        <MetricCard label="Reply Profiles" value={learning.personalityProfiles} variant="compact" />
      </div>

      <div className="learning-highlights">
        <MetricCard
          label="Reply Style"
          value={dominantMode}
          tone="accent"
          variant="compact"
          className="metric-highlight"
        />
        <MetricCard
          label="Top Failure Signature"
          value={topFailure}
          tone={learning.topFailureKind === 'none' ? 'neutral' : 'warning'}
          variant="compact"
          className="metric-highlight metric-value-wrap"
          valueTitle={topFailure}
        />
      </div>

      {learning.profilesByMode.length > 1 ? (
        <div className="learning-mode-section">
          <div className="section-label">Profiles by Reply Style</div>
          <div className="mode-heat-grid">
            {learning.profilesByMode.map(mode => (
              <article className="mode-card" key={mode.mode}>
                <span>{humanizeMode(mode.mode)}</span>
                <strong>{mode.count}</strong>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export type SortField = 'updatedAt' | 'createdAt' | 'status' | 'workflow';
export type SortDirection = 'asc' | 'desc';

export function RunsFilterBar({
  statusFilter,
  onStatusFilterChange,
  searchQuery,
  onSearchQueryChange,
}: {
  statusFilter: string;
  onStatusFilterChange: (value: string) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
}) {
  return (
    <div className="runs-filter-bar">
      <select value={statusFilter} onChange={e => onStatusFilterChange(e.target.value)}>
        <option value="all">All Statuses</option>
        <option value="running">Running</option>
        <option value="success">Success</option>
        <option value="failed">Failed</option>
      </select>
      <input
        type="text"
        placeholder="Search tasks or workflows\u2026"
        value={searchQuery}
        onChange={e => onSearchQueryChange(e.target.value)}
      />
    </div>
  );
}

export function RunsTable({
  runs,
  onSelectRun,
  onCancelRun,
  sortField,
  sortDirection,
  onSort,
}: {
  runs: RunSummary[];
  onSelectRun: (runId: string) => void;
  onCancelRun?: (runId: string) => void;
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
}) {
  if (runs.length === 0) {
    return <EmptyState>No runs match the current filters.</EmptyState>;
  }

  const sortArrow = (field: SortField) => {
    if (sortField !== field) return null;
    return <span className="sort-arrow">{sortDirection === 'asc' ? '\u25B2' : '\u25BC'}</span>;
  };

  const isCancellable = (status: string) => status === 'RUNNING' || status === 'PAUSED';

  return (
    <div className="runs-table-wrap">
      <table className="runs-table">
        <thead>
          <tr>
            <th className="sortable" onClick={() => onSort('status')}>
              Status {sortArrow('status')}
            </th>
            <th>Task</th>
            <th className="sortable" onClick={() => onSort('workflow')}>
              Workflow {sortArrow('workflow')}
            </th>
            <th className="col-channel">Channel</th>
            <th className="sortable col-updated" onClick={() => onSort('updatedAt')}>
              Updated {sortArrow('updatedAt')}
            </th>
            {onCancelRun && <th className="col-actions" />}
          </tr>
        </thead>
        <tbody>
          {runs.map(run => (
            <tr key={run.id} className="runs-table-row" onClick={() => onSelectRun(run.id)}>
              <td>
                <StatusBadge label={run.status} tone={getStatusTone(run.status)} />
              </td>
              <td className="task-cell">{run.taskSummary}</td>
              <td className="workflow-cell">{run.workflow}</td>
              <td className="channel-cell col-channel">{run.channelId}</td>
              <td className="updated-cell col-updated">
                <Timestamp value={run.updatedAt} />
              </td>
              {onCancelRun && (
                <td className="actions-cell col-actions">
                  {isCancellable(run.status) && (
                    <button
                      className="cancel-btn"
                      title="Cancel this job"
                      onClick={e => {
                        e.stopPropagation();
                        onCancelRun(run.id);
                      }}
                    >
                      &times;
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type StageGroup = {
  stage: string;
  startTime: string;
  worstLevel: 'INFO' | 'WARN' | 'ERROR';
  entries: JobLogEntry[];
};

export function groupByStage(logs: JobLogEntry[]): StageGroup[] {
  const groups: StageGroup[] = [];
  for (const log of logs) {
    const last = groups[groups.length - 1];
    if (last && last.stage === log.stage) {
      last.entries.push(log);
      if (log.level === 'ERROR') last.worstLevel = 'ERROR';
      else if (log.level === 'WARN' && last.worstLevel !== 'ERROR') last.worstLevel = 'WARN';
    } else {
      groups.push({
        stage: log.stage,
        startTime: log.createdAt,
        worstLevel: (log.level === 'ERROR'
          ? 'ERROR'
          : log.level === 'WARN'
            ? 'WARN'
            : 'INFO') as StageGroup['worstLevel'],
        entries: [log],
      });
    }
  }
  return groups;
}

function levelIndicator(level: string): { symbol: string; className: string } {
  if (level === 'ERROR' || level.toLowerCase().includes('error'))
    return { symbol: '\u2717', className: 'shell-level-error' };
  if (level === 'WARN' || level.toLowerCase().includes('warn'))
    return { symbol: '\u26A0', className: 'shell-level-warn' };
  return { symbol: '\u00B7', className: 'shell-level-info' };
}

function jsonKeyCount(raw: string): number {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? Object.keys(parsed).length : 0;
  } catch {
    return 0;
  }
}

export function ShellTraceView({ logs, highlightStage }: { logs: JobLogEntry[]; highlightStage?: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (el && wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs.length]);

  useEffect(() => {
    if (!highlightStage || !containerRef.current) return;
    const target = containerRef.current.querySelector(`[data-stage="${CSS.escape(highlightStage)}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [highlightStage]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (el) {
      wasAtBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    }
  };

  if (logs.length === 0) {
    return <EmptyState>No trace entries have been persisted for this run yet.</EmptyState>;
  }

  const groups = groupByStage(logs);

  return (
    <div className="shell-trace" ref={containerRef} onScroll={handleScroll}>
      {groups.map((group, gi) => {
        const borderClass =
          group.worstLevel === 'ERROR' ? 'shell-group-error' : group.worstLevel === 'WARN' ? 'shell-group-warn' : '';

        return (
          <div
            key={`${group.stage}-${gi}`}
            className={`shell-group ${borderClass}${highlightStage === group.stage ? ' shell-group-highlight' : ''}`}
            data-stage={group.stage}
          >
            <div className="shell-group-header">
              <span className="shell-group-stage">
                {'\u25B8'} {group.stage}
              </span>
              <span className="shell-group-time">
                <Timestamp value={group.startTime} />
              </span>
            </div>

            {group.entries.map(log => {
              const { symbol, className } = levelIndicator(log.level);
              const lineClass =
                log.level === 'ERROR'
                  ? 'shell-line shell-line-error'
                  : log.level === 'WARN'
                    ? 'shell-line shell-line-warn'
                    : 'shell-line';

              return (
                <div key={log.id} className={lineClass}>
                  <span className={`shell-indicator ${className}`}>{symbol}</span>
                  <span className="shell-message">
                    <SlackMarkdown text={log.message} />
                  </span>
                  {log.dataJson ? (
                    <details className="shell-json">
                      <summary>
                        JSON payload{' '}
                        <span className="shell-json-hint">
                          {'\u00B7'} {jsonKeyCount(log.dataJson)} keys
                        </span>
                      </summary>
                      <pre>{prettyJson(log.dataJson)}</pre>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

type WorkflowNodeStatus = 'passed' | 'failed' | 'warning' | 'running' | 'pending';

type WorkflowNode = {
  stage: string;
  status: WorkflowNodeStatus;
  entryCount: number;
  durationMs: number | null;
  errorMessage: string | null;
};

function deriveWorkflowNodes(logs: JobLogEntry[], pipelineRun?: PipelineRunData | null): WorkflowNode[] {
  const stages = groupByStage(logs);

  return stages.map(group => {
    const pipelineStep = pipelineRun?.steps.find(s => s.role.toUpperCase() === group.stage.toUpperCase());

    let status: WorkflowNodeStatus;
    let durationMs: number | null = null;

    if (pipelineStep) {
      status =
        pipelineStep.status === 'passed'
          ? 'passed'
          : pipelineStep.status === 'failed'
            ? 'failed'
            : pipelineStep.status === 'running'
              ? 'running'
              : 'pending';
      durationMs = pipelineStep.durationMs;
    } else {
      status = group.worstLevel === 'ERROR' ? 'failed' : group.worstLevel === 'WARN' ? 'warning' : 'passed';
    }

    const errorEntry = group.entries.find(e => e.level === 'ERROR');
    const errorMessage = errorEntry ? errorEntry.message : null;

    return { stage: group.stage, status, entryCount: group.entries.length, durationMs, errorMessage };
  });
}

function wfStatusIcon(status: WorkflowNodeStatus): string {
  switch (status) {
    case 'passed':
      return '\u2713';
    case 'failed':
      return '\u2717';
    case 'warning':
      return '\u26A0';
    case 'running':
      return '\u25CB';
    case 'pending':
      return '\u00B7';
  }
}

function wfConnectorStroke(status: WorkflowNodeStatus): string {
  switch (status) {
    case 'passed':
      return 'rgba(40, 200, 64, 0.4)';
    case 'failed':
      return 'rgba(255, 95, 87, 0.4)';
    case 'running':
      return 'rgba(94, 234, 212, 0.5)';
    case 'warning':
      return 'rgba(254, 188, 46, 0.4)';
    default:
      return 'rgba(255, 255, 255, 0.08)';
  }
}

function wfBezierPath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = (x2 - x1) * 0.5;
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
}

function wfFormatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function wfStatusLabel(status: WorkflowNodeStatus): string {
  switch (status) {
    case 'passed':
      return 'Passed';
    case 'failed':
      return 'Failed';
    case 'warning':
      return 'Warning';
    case 'running':
      return 'Running';
    case 'pending':
      return 'Pending';
  }
}

export function WorkflowGraph({
  logs,
  pipelineRun,
  activeStage,
  onStageClick,
}: {
  logs: JobLogEntry[];
  pipelineRun?: PipelineRunData | null;
  activeStage?: string | null;
  onStageClick?: (stage: string) => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [connectors, setConnectors] = useState<
    Array<{ x1: number; y1: number; x2: number; y2: number; status: WorkflowNodeStatus }>
  >([]);
  const [hoveredStage, setHoveredStage] = useState<string | null>(null);

  const nodes = useMemo(() => deriveWorkflowNodes(logs, pipelineRun), [logs, pipelineRun]);

  useEffect(() => {
    nodeRefs.current = nodeRefs.current.slice(0, nodes.length);
  }, [nodes.length]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length < 2) {
      setConnectors([]);
      return;
    }

    const measure = () => {
      const canvasRect = canvas.getBoundingClientRect();
      const lines: typeof connectors = [];

      for (let i = 0; i < nodes.length - 1; i++) {
        const fromEl = nodeRefs.current[i];
        const toEl = nodeRefs.current[i + 1];
        if (!fromEl || !toEl) continue;

        const fromRect = fromEl.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();

        lines.push({
          x1: fromRect.right - canvasRect.left,
          y1: fromRect.top + fromRect.height / 2 - canvasRect.top,
          x2: toRect.left - canvasRect.left,
          y2: toRect.top + toRect.height / 2 - canvasRect.top,
          status: nodes[i].status,
        });
      }

      setConnectors(lines);
    };

    requestAnimationFrame(measure);

    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [nodes]);

  if (nodes.length === 0) return null;

  return (
    <div className="wf-playground">
      <div className="wf-graph-canvas" ref={canvasRef}>
        {nodes.map((node, i) => {
          const isActive = activeStage === node.stage;
          const nodeClass = ['wf-node', `wf-node-${node.status}`, isActive ? 'wf-node-active' : '']
            .filter(Boolean)
            .join(' ');

          return (
            <div
              key={node.stage}
              ref={el => {
                nodeRefs.current[i] = el;
              }}
              className={nodeClass}
              style={{ animationDelay: `${i * 100}ms` }}
              onClick={() => onStageClick?.(node.stage)}
              onMouseEnter={() => setHoveredStage(node.stage)}
              onMouseLeave={() => setHoveredStage(null)}
            >
              <div className={`wf-node-ring wf-ring-${node.status}`}>
                <span className="wf-node-icon">{wfStatusIcon(node.status)}</span>
              </div>
              <span className="wf-node-label">{node.stage}</span>
              <span className="wf-node-badge">
                {node.durationMs != null ? wfFormatDuration(node.durationMs) : `${node.entryCount} entries`}
              </span>

              {hoveredStage === node.stage ? (
                <div className="wf-tooltip">
                  <div className="wf-tooltip-row">
                    <span>Status</span>
                    <strong className={`wf-tooltip-status wf-tooltip-${node.status}`}>
                      {wfStatusLabel(node.status)}
                    </strong>
                  </div>
                  <div className="wf-tooltip-row">
                    <span>Entries</span>
                    <strong>{node.entryCount}</strong>
                  </div>
                  {node.durationMs != null ? (
                    <div className="wf-tooltip-row">
                      <span>Duration</span>
                      <strong>{wfFormatDuration(node.durationMs)}</strong>
                    </div>
                  ) : null}
                  {node.errorMessage ? <div className="wf-tooltip-error">{node.errorMessage}</div> : null}
                </div>
              ) : null}
            </div>
          );
        })}

        <svg className="wf-connectors">
          <defs>
            <filter id="wf-glow">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {connectors.map((c, i) => {
            const pathD = wfBezierPath(c.x1, c.y1, c.x2, c.y2);
            const stroke = wfConnectorStroke(c.status);
            const isActive = c.status === 'running';
            const isDone = c.status === 'passed' || c.status === 'failed' || c.status === 'warning';
            const pathId = `wf-path-${i}`;

            return (
              <g key={i}>
                <path
                  d={pathD}
                  fill="none"
                  stroke={stroke}
                  strokeWidth={isDone || isActive ? 2 : 1.5}
                  opacity={isDone ? 1 : 0.6}
                  filter={isActive ? 'url(#wf-glow)' : undefined}
                />
                {isActive ? (
                  <>
                    <path
                      d={pathD}
                      fill="none"
                      stroke={stroke}
                      strokeWidth={2}
                      strokeDasharray="6 4"
                      className="wf-connector-active"
                    />
                    <path id={pathId} d={pathD} fill="none" stroke="none" />
                    <circle r="3" fill="rgba(94, 234, 212, 0.8)" filter="url(#wf-glow)">
                      <animateMotion dur="1.5s" repeatCount="indefinite">
                        <mpath xlinkHref={`#${pathId}`} />
                      </animateMotion>
                    </circle>
                    <circle r="2" fill="rgba(94, 234, 212, 0.5)">
                      <animateMotion dur="1.5s" repeatCount="indefinite" begin="0.3s">
                        <mpath xlinkHref={`#${pathId}`} />
                      </animateMotion>
                    </circle>
                  </>
                ) : null}
                {isDone ? (
                  <>
                    <path id={pathId} d={pathD} fill="none" stroke="none" />
                    <circle r="2" fill={stroke} opacity={0.6}>
                      <animateMotion dur="3s" repeatCount="indefinite">
                        <mpath xlinkHref={`#${pathId}`} />
                      </animateMotion>
                    </circle>
                  </>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
