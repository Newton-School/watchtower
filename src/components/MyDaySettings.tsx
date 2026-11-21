import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { MyDay } from '../types';
import { useEscapeLayer } from '../lib/escapeLayers';
import { money, shortWhen } from '../lib/myDay';

const POLICY_ROWS: Array<{ name: string; label: string; detail: string }> = [
  { name: 'review', label: 'Reviews and re-reviews', detail: 'Posted on GitHub as comments. Never an approval.' },
  { name: 'fix_own_pr', label: 'Fixes on your PRs', detail: "Pushed for reviewers' comments. Never merged." },
  { name: 'open_pr', label: 'New PRs for clear asks', detail: 'Opened ready for review. Never merged or deployed.' },
  { name: 'tag', label: "miniOG's line after a review", detail: 'Tags the asker in their thread with the result.' },
];

const POLICY_VALUES: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'On its own' },
  { value: 'ask', label: 'Ask me' },
  { value: 'off', label: 'Off' },
];

const SPANS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Since the last sweep' },
  { value: '1d', label: 'The last day' },
  { value: '3d', label: 'The last 3 days' },
  { value: '7d', label: 'The last week' },
];

/** Runs the app sends: with more than this in a week, the week's total covers only these. */
const RUN_HISTORY = 14;

const STATUS_WORDS: Record<string, string> = {
  OK: 'Done',
  PARTIAL: 'Missed a source',
  FAILED: 'Failed',
  RUNNING: 'Running',
};

export function MyDaySettings({
  day,
  now,
  running,
  onClose,
  onSaveSchedule,
  onSavePolicy,
  onRunNow,
}: {
  day: MyDay | null;
  now: number;
  running: boolean;
  onClose: () => void;
  onSaveSchedule: (enabled: boolean, runTime: string) => Promise<void>;
  onSavePolicy: (name: string, value: string) => Promise<void>;
  onRunNow: (span: string | null, prepareOnly: boolean) => Promise<void>;
}) {
  useEscapeLayer(true, onClose);
  const [span, setSpan] = useState('');
  const [prepareOnly, setPrepareOnly] = useState(false);
  // Saved on leaving the field: typing passes through times that aren't the one meant.
  const [runTimeDraft, setRunTimeDraft] = useState<string | null>(null);
  // One save at a time, in order, each with the latest time: leaving the time field and
  // then ticking the box sends two, and neither may undo the other.
  const savedTime = useRef<string | null>(null);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const saveSchedule = (enabled: boolean, runTime: string) => {
    savedTime.current = runTime;
    saving.current = saving.current.then(() => onSaveSchedule(enabled, runTime)).catch(() => undefined);
  };
  const runs = day?.runs ?? [];
  const week = runs.filter(run => now - Date.parse(run.startedAt) < 7 * 24 * 60 * 60 * 1000);
  const weekCost = week.reduce((total, run) => total + run.costUsd, 0);
  const weekCut = runs.length >= RUN_HISTORY && week.length === runs.length;

  return (
    <div className="myday-drawer-layer">
      <button className="myday-drawer-scrim" type="button" aria-label="Close settings" onClick={onClose} />
      <aside className="myday-drawer" role="dialog" aria-label="My day settings">
        <header className="myday-drawer-head">
          <h2>My day settings</h2>
          <button className="icon-button" type="button" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <section className="myday-drawer-section">
          <h3>Nightly sweep</h3>
          <p className="muted">
            Reads your Slack and GitHub for asks that neither you nor miniOG finished, and lines them up here.
          </p>
          <div className="myday-schedule">
            <label className="myday-check">
              <input
                type="checkbox"
                checked={Boolean(day?.enabled)}
                disabled={!day}
                onChange={event =>
                  saveSchedule(event.target.checked, runTimeDraft ?? savedTime.current ?? day?.runTime ?? '22:00')
                }
              />
              Sweep every night at
            </label>
            <input
              className="myday-input"
              aria-label="Sweep time"
              type="time"
              value={runTimeDraft ?? day?.runTime ?? '22:00'}
              disabled={!day}
              onChange={event => setRunTimeDraft(event.target.value)}
              onBlur={() => {
                if (runTimeDraft && runTimeDraft !== (savedTime.current ?? day?.runTime))
                  saveSchedule(Boolean(day?.enabled), runTimeDraft);
                setRunTimeDraft(null);
              }}
            />
          </div>
        </section>

        <section className="myday-drawer-section">
          <h3>What miniOG does on its own</h3>
          <p className="muted">
            Merging, approving and deploying never happen on their own: they need your tap on the item. Replies are
            always drafts for you to send.
          </p>
          <div className="myday-policies">
            {POLICY_ROWS.map(row => {
              const value = day?.policies[row.name] ?? 'auto';
              return (
                <div key={row.name} className="myday-policy">
                  <div>
                    <strong>{row.label}</strong>
                    <span className="muted">{row.detail}</span>
                  </div>
                  <div className="myday-segmented" role="group" aria-label={row.label}>
                    {POLICY_VALUES.map(option => (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={value === option.value}
                        className={value === option.value ? 'is-on' : ''}
                        disabled={!day}
                        onClick={() => void onSavePolicy(row.name, option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="myday-drawer-section">
          <h3>Sweep now</h3>
          <div className="myday-schedule">
            <select
              className="myday-input"
              aria-label="Sweep window"
              value={span}
              onChange={event => setSpan(event.target.value)}
            >
              {SPANS.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <label className="myday-check" title="Find what's open, but start no work and save no drafts">
              <input type="checkbox" checked={prepareOnly} onChange={event => setPrepareOnly(event.target.checked)} />
              Only look, don't act
            </label>
            <button
              className="primary-button myday-btn"
              type="button"
              disabled={running}
              onClick={() => void onRunNow(span || null, prepareOnly)}
            >
              Sweep now
            </button>
          </div>
        </section>

        <section className="myday-drawer-section">
          <h3>Recent sweeps</h3>
          {runs.length === 0 ? (
            <p className="muted">No sweeps yet.</p>
          ) : (
            <>
              <p className="muted">
                {weekCut ? `The last ${runs.length} sweeps cost` : 'The last 7 days cost'} {money(weekCost)}: reading
                Slack, and the reviews and changes My day started.
              </p>
              <table className="myday-runs">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Result</th>
                    <th>Sweep</th>
                    <th>Work</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map(run => (
                    <tr key={run.startedAt}>
                      <td>
                        {shortWhen(run.startedAt, now)}
                        {run.trigger === 'manual' ? ' · by you' : ''}
                        {run.prepareOnly ? ' · look only' : ''}
                      </td>
                      <td>
                        <span className={`myday-dot tone-${run.status.toLowerCase()}`} aria-hidden="true" />
                        {STATUS_WORDS[run.status] ?? run.status}
                        {run.gaps.length > 0 ? ` · ${run.gaps.length} blind spots` : ''}
                      </td>
                      <td>{money(run.sweepCostUsd)}</td>
                      <td>{money(run.workCostUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      </aside>
    </div>
  );
}
