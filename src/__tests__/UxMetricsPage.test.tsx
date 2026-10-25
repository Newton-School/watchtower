import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { UxMetricsPage } from '../pages/UxMetricsPage';
import type { UxMetrics, UxWindow } from '../types';

function emptyWindow(sinceIso: string, untilIso: string): UxWindow {
  return {
    sinceIso,
    untilIso,
    jobs: 0,
    steps: [
      { key: 'firstReply', label: 'First reply', count: 0, medianMs: null, p90Ms: null },
      { key: 'plan', label: 'Plan posted', count: 0, medianMs: null, p90Ms: null },
    ],
    interventions: { changeRuns: 0, total: 0, meanPerRun: null, medianPerRun: null },
    messages: [],
    outcomes: [],
    byTool: [],
    byChannel: [],
  };
}

function metricsFixture(): UxMetrics {
  const previous = emptyWindow('2026-10-12T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
  previous.jobs = 3;
  previous.steps[0] = { key: 'firstReply', label: 'First reply', count: 3, medianMs: 20_000, p90Ms: 60_000 };
  previous.byChannel = [{ key: 'C1', label: 'development', count: 3 }];
  return {
    untilIso: '2026-10-26T00:00:00.000Z',
    previous,
    current: {
      sinceIso: '2026-10-19T00:00:00.000Z',
      untilIso: '2026-10-26T00:00:00.000Z',
      jobs: 5,
      steps: [
        { key: 'firstReply', label: 'First reply', count: 5, medianMs: 8_000, p90Ms: 90_000 },
        { key: 'plan', label: 'Plan posted', count: 2, medianMs: 75_000, p90Ms: 140_000 },
      ],
      interventions: { changeRuns: 2, total: 3, meanPerRun: 1.5, medianPerRun: 1.5 },
      messages: [{ tool: 'IMPLEMENTATION', runs: 2, mean: 4.5, median: 4.5 }],
      outcomes: [{ tool: 'INFORMATIONAL', jobs: 3, failed: 1, cancelled: 0 }],
      byTool: [{ key: 'INFORMATIONAL', label: 'INFORMATIONAL', count: 3 }],
      byChannel: [
        { key: 'C1', label: 'development', count: 4 },
        { key: 'D0AG35GQP4N', label: 'D0AG35GQP4N', count: 1 },
      ],
    },
  };
}

describe('UxMetricsPage', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it('shows this week beside last week', async () => {
    invoke.mockResolvedValue(metricsFixture());
    render(<UxMetricsPage />);

    const reply = await screen.findByText('First reply');
    const row = reply.closest('tr') as HTMLElement;
    expect(within(row).getByText('8s')).toBeTruthy();
    expect(within(row).getByText('20s')).toBeTruthy();
    expect(within(row).getByText('60% faster')).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith('get_ux_metrics', expect.objectContaining({ untilIso: expect.any(String) }));
    expect(screen.getByText('Change run')).toBeTruthy();
    expect(screen.getAllByText('Lookup').length).toBe(2);
    expect(screen.getByText('#development')).toBeTruthy();
    expect(screen.getByText('Direct message')).toBeTruthy();
    expect(screen.getAllByText('1.5').length).toBeGreaterThan(0);
  });

  it('says so when there are no requests yet', async () => {
    invoke.mockResolvedValue({
      untilIso: '2026-10-26T00:00:00.000Z',
      current: emptyWindow('2026-10-19T00:00:00.000Z', '2026-10-26T00:00:00.000Z'),
      previous: emptyWindow('2026-10-12T00:00:00.000Z', '2026-10-19T00:00:00.000Z'),
    });
    render(<UxMetricsPage />);

    expect(await screen.findByText(/No requests in the last 14 days yet/)).toBeTruthy();
    expect(screen.queryByText('First reply')).toBeNull();
  });

  it('shows the error when the store cannot be read', async () => {
    invoke.mockRejectedValue(new Error('db open failed: locked'));
    render(<UxMetricsPage />);

    expect(await screen.findByText(/db open failed: locked/)).toBeTruthy();
  });
});
