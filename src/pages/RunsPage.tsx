import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DashboardData, JobCostSummary, JobLogEntry, PipelineRunData, RunSummary } from '../types';
import {
  PageIntro,
  RunsFilterBar,
  RunsTable,
  ShellTraceView,
  SlackMarkdown,
  StatusBadge,
  WorkflowGraph,
} from '../components/primitives';
import type { SortDirection, SortField } from '../components/primitives';
import { formatCostUsd, formatDurationMs, formatPercent, formatTokens, getStatusTone } from '../lib/formatters';
import { Timestamp } from '../components/Timestamp';
import { AgentPipelineView } from '../components/AgentPipelineView';
import { GlowCard } from '../components/GlowCard';
import { RunReactions } from '../components/RunReactions';

type RunsPageProps = {
  data: DashboardData | null;
  onReviewChanges?: (runId: string) => void;
  onSelectRun: (runId: string) => void;
  onRefresh?: () => void;
  selectedRunId: string | null;
  selectedRunLogs: JobLogEntry[];
  selectedRunPipeline?: PipelineRunData | null;
};

export function RunsPage({
  data,
  onReviewChanges: _onReviewChanges,
  onSelectRun,
  onRefresh,
  selectedRunId,
  selectedRunLogs,
  selectedRunPipeline,
}: RunsPageProps) {
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('updatedAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [costSummary, setCostSummary] = useState<JobCostSummary | null>(null);

  useEffect(() => {
    if (!detailRunId) {
      setCostSummary(null);
      return;
    }
    let cancelled = false;
    invoke<JobCostSummary>('get_job_cost_summary', { jobId: detailRunId })
      .then(summary => {
        if (!cancelled) setCostSummary(summary);
      })
      .catch(() => {
        if (!cancelled) setCostSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [detailRunId]);

  const allRuns = useMemo(() => {
    if (!data) return [] as RunSummary[];
    const map = new Map<string, RunSummary>();
    for (const run of [...data.activeJobs, ...data.recentRuns, ...data.failures]) {
      map.set(run.id, run);
    }
    return Array.from(map.values());
  }, [data]);

  const selectedRun = useMemo(() => {
    if (!detailRunId) return null;
    return allRuns.find(r => r.id === detailRunId) ?? null;
  }, [allRuns, detailRunId]);

  const filteredRuns = useMemo(() => {
    let runs = allRuns;

    if (statusFilter !== 'all') {
      runs = runs.filter(r => {
        const s = r.status.toLowerCase();
        if (statusFilter === 'running') return s.includes('run') || s.includes('progress') || s.includes('queue');
        if (statusFilter === 'success') return s.includes('success') || s.includes('done') || s.includes('complete');
        if (statusFilter === 'failed') return s.includes('fail') || s.includes('error');
        return true;
      });
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      runs = runs.filter(r => r.taskSummary.toLowerCase().includes(q) || r.workflow.toLowerCase().includes(q));
    }

    return [...runs].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'updatedAt') cmp = new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
      else if (sortField === 'createdAt') cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      else if (sortField === 'status') cmp = a.status.localeCompare(b.status);
      else if (sortField === 'workflow') cmp = a.workflow.localeCompare(b.workflow);
      return sortDirection === 'desc' ? -cmp : cmp;
    });
  }, [allRuns, statusFilter, searchQuery, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDirection(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const handleSelectRun = (runId: string) => {
    setDetailRunId(runId);
    onSelectRun(runId);
  };

  const handleCancelRun = async (runId: string) => {
    try {
      await invoke('cancel_job', { jobId: runId });
      onRefresh?.();
    } catch {
      // Non-fatal
    }
  };

  useEffect(() => {
    if (!detailRunId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDetailRunId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [detailRunId]);

  // If navigated here with a selectedRunId from OverviewPage, open its detail
  useEffect(() => {
    if (selectedRunId && !detailRunId && allRuns.some(r => r.id === selectedRunId)) {
      setDetailRunId(selectedRunId);
    }
  }, []); // only on mount

  // Detail View
  if (detailRunId && selectedRun) {
    return (
      <div className="page-stack">
        <button className="ghost-button run-detail-back" type="button" onClick={() => setDetailRunId(null)}>
          &larr; Back to Runs
        </button>

        <GlowCard>
          <article className="surface-card detail-card">
            <div className="run-detail-header">
              <div className="run-detail-header-copy">
                <span className="eyebrow">{selectedRun.workflow.replaceAll('_', ' ')}</span>
                <h1>{selectedRun.taskSummary}</h1>
              </div>
              <div className="run-detail-header-actions">
                <StatusBadge label={selectedRun.status} tone={getStatusTone(selectedRun.status)} />
                {/*
                 * Review Changes button is intentionally omitted: nothing in
                 * the codebase calls JobStore.saveDiff(), so job_diffs is
                 * never populated and ReviewPage hits a guaranteed no-diff
                 * dead-end. Re-add this entry point once successful
                 * code-producing jobs persist their diff.
                 */}
              </div>
            </div>

            <div className="detail-grid">
              <div>
                <span>Job ID</span>
                <strong>{selectedRun.id}</strong>
              </div>
              <div>
                <span>Channel</span>
                <strong>{selectedRun.channelId}</strong>
              </div>
              <div>
                <span>Thread</span>
                <strong>{selectedRun.threadTs}</strong>
              </div>
              <div>
                <span>Created</span>
                <strong>
                  <Timestamp value={selectedRun.createdAt} />
                </strong>
              </div>
              <div>
                <span>Updated</span>
                <strong>
                  <Timestamp value={selectedRun.updatedAt} />
                </strong>
              </div>
              <div>
                <span>Trace Entries</span>
                <strong>{selectedRunLogs.length}</strong>
              </div>
              <div>
                <span>Cost</span>
                <strong>{formatCostUsd(costSummary?.totalCostUsd ?? null)}</strong>
              </div>
              <div>
                <span>Tokens (in / out)</span>
                <strong>
                  {formatTokens(costSummary?.totalInputTokens ?? null)}
                  {' / '}
                  {formatTokens(costSummary?.totalOutputTokens ?? null)}
                </strong>
              </div>
              <div>
                <span>Cache Hit</span>
                <strong>
                  {(() => {
                    if (!costSummary) return '—';
                    const denom = costSummary.totalInputTokens + costSummary.totalCacheReadTokens;
                    return denom > 0 ? formatPercent(costSummary.totalCacheReadTokens / denom) : '—';
                  })()}
                </strong>
              </div>
            </div>

            {selectedRun.errorMessage ? (
              <div className="detail-error">
                <SlackMarkdown text={selectedRun.errorMessage} />
              </div>
            ) : null}
          </article>
        </GlowCard>

        <RunReactions jobId={selectedRun.id} running={['RUNNING', 'QUEUED', 'CLAIMED'].includes(selectedRun.status)} />

        {selectedRunLogs.length > 0 ? (
          <GlowCard>
            <section className="surface-card">
              <div className="section-head">
                <div className="section-heading-copy">
                  <div className="section-title-row">
                    <h2>Workflow</h2>
                  </div>
                  <p className="muted">Pipeline stage progression</p>
                </div>
              </div>
              <WorkflowGraph
                logs={selectedRunLogs}
                pipelineRun={selectedRunPipeline}
                activeStage={activeStage}
                onStageClick={setActiveStage}
              />
            </section>
          </GlowCard>
        ) : null}

        {costSummary && costSummary.callCount > 0 ? (
          <GlowCard>
            <section className="surface-card">
              <div className="section-head">
                <div className="section-heading-copy">
                  <div className="section-title-row">
                    <h2>Cost &amp; Tokens</h2>
                    <span className="section-count">{costSummary.callCount}</span>
                  </div>
                  <p className="muted">Per-agent invocation cost, latency, and token usage</p>
                </div>
              </div>
              <div className="detail-grid">
                <div>
                  <span>Total cost</span>
                  <strong>{formatCostUsd(costSummary.totalCostUsd)}</strong>
                </div>
                <div>
                  <span>Total wall-clock</span>
                  <strong>{formatDurationMs(costSummary.totalDurationMs)}</strong>
                </div>
                <div>
                  <span>Input tokens</span>
                  <strong>{formatTokens(costSummary.totalInputTokens)}</strong>
                </div>
                <div>
                  <span>Output tokens</span>
                  <strong>{formatTokens(costSummary.totalOutputTokens)}</strong>
                </div>
                <div>
                  <span>Cache read tokens</span>
                  <strong>{formatTokens(costSummary.totalCacheReadTokens)}</strong>
                </div>
                <div>
                  <span>Calls</span>
                  <strong>{costSummary.callCount}</strong>
                </div>
              </div>
              <div className="cost-table-scroll">
                <table className="cost-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Role</th>
                      <th>Backend</th>
                      <th>Model</th>
                      <th className="num">Duration</th>
                      <th className="num">In</th>
                      <th className="num">Out</th>
                      <th className="num">Cache R</th>
                      <th className="num">Cost</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costSummary.calls.map(call => (
                      <tr key={call.id} className={call.ok ? '' : 'row-failed'}>
                        <td>
                          <Timestamp value={call.createdAt} />
                        </td>
                        <td>{call.role ?? '—'}</td>
                        <td>{call.backend}</td>
                        <td className="muted">{call.model ?? '—'}</td>
                        <td className="num">{formatDurationMs(call.durationMs)}</td>
                        <td className="num">{formatTokens(call.inputTokens)}</td>
                        <td className="num">{formatTokens(call.outputTokens)}</td>
                        <td className="num">{formatTokens(call.cacheReadTokens)}</td>
                        <td className="num">{formatCostUsd(call.costUsd)}</td>
                        <td className="muted">{call.costSource ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </GlowCard>
        ) : null}

        <GlowCard>
          <section className="surface-card">
            <div className="section-head">
              <div className="section-heading-copy">
                <div className="section-title-row">
                  <h2>Execution Trace</h2>
                  <span className="section-count">{selectedRunLogs.length}</span>
                </div>
                <p className="muted">Terminal-style trace for {selectedRun.id}</p>
              </div>
            </div>
            <ShellTraceView logs={selectedRunLogs} highlightStage={activeStage} />
          </section>
        </GlowCard>

        {selectedRunPipeline ? (
          <AgentPipelineView pipelineRun={selectedRunPipeline} calls={costSummary?.calls} />
        ) : null}
      </div>
    );
  }

  // Table View
  return (
    <div className="page-stack">
      <PageIntro
        eyebrow="Operational Workspace"
        title="Runs"
        description="All workflow executions in one view. Click any row to inspect its trace and metadata."
      />

      <RunsFilterBar
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
      />

      <GlowCard>
        <section className="surface-card">
          <RunsTable
            runs={filteredRuns}
            onSelectRun={handleSelectRun}
            onCancelRun={handleCancelRun}
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
          />
        </section>
      </GlowCard>
    </div>
  );
}
