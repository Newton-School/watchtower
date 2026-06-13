import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { AppShell } from './components/AppShell';
import { LiveLogConsole } from './components/primitives';
import { applyAppTheme } from './lib/theme';
import { formatSidecarLine } from './lib/formatters';
import { IntelligencePage } from './pages/IntelligencePage';
import { PerformancePage } from './pages/PerformancePage';
import { LaunchpadPage } from './pages/LaunchpadPage';
import { OverviewPage } from './pages/OverviewPage';
import { RunsPage } from './pages/RunsPage';
import { DossierPage } from './pages/DossierPage';
import { ReviewPage } from './pages/ReviewPage';
import { SettingsPage } from './pages/SettingsPage';
import type {
  AppSettings,
  AppNotificationPayload,
  AppView,
  DashboardData,
  ImportNotificationAudioResponse,
  JobLogEntry,
  LaunchpadSubmitResponse,
  NotificationAudioTone,
  RunSummary,
  SaveSettingsResponse,
  SlackCommandTarget,
} from './types';

const POLL_MS = 5000;
const NOTIFICATION_AUDIO_MAX_BYTES = 10 * 1024 * 1024;
const PENDING_SHORTCUT_VIEW_KEY = 'watchtower:pending-shortcut-view';
const PENDING_SHORTCUT_TARGET_KEY = 'watchtower:pending-shortcut-target';
const APP_NOTIFICATION_EVENT = 'watchtower-notification';

function toggleSlackCommandTarget(target: SlackCommandTarget): SlackCommandTarget {
  return target === 'miniog' ? 'watchtower' : 'miniog';
}

function readPendingShortcutView(): AppView | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const value = window.localStorage.getItem(PENDING_SHORTCUT_VIEW_KEY);
  return value === 'launchpad' ? 'launchpad' : null;
}

function readPendingShortcutTarget(): SlackCommandTarget | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const value = window.localStorage.getItem(PENDING_SHORTCUT_TARGET_KEY);
  return value === 'miniog' || value === 'watchtower' ? value : null;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => {
      reject(new Error(`Unable to read ${file.name}`));
    };

    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(`Unable to encode ${file.name}`));
        return;
      }

      const [, base64 = ''] = reader.result.split(',', 2);
      if (!base64) {
        reject(new Error(`Unable to encode ${file.name}`));
        return;
      }

      resolve(base64);
    };

    reader.readAsDataURL(file);
  });
}

function applyNotificationAudioImport(current: AppSettings, tone: NotificationAudioTone, path: string): AppSettings {
  if (tone === 'success') {
    return {
      ...current,
      successNotificationAudioMode: 'custom',
      successNotificationAudioCustomPath: path,
    };
  }

  return {
    ...current,
    failureNotificationAudioMode: 'custom',
    failureNotificationAudioCustomPath: path,
  };
}

function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [view, setView] = useState<AppView>('launchpad');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [selectedRunPipeline, setSelectedRunPipeline] = useState<any>(null);
  const [selectedRunLogs, setSelectedRunLogs] = useState<JobLogEntry[]>([]);
  const [liveSidecarLogs, setLiveSidecarLogs] = useState<Array<{ id: number; content: string }>>([]);
  // Monotonic id per ingested log line so LiveLogConsole keys are stable across
  // the 400-line trim (index-based keys shift on every trim, remounting rows).
  const sidecarLogSeq = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [uploadingNotificationAudioTone, setUploadingNotificationAudioTone] = useState<NotificationAudioTone | null>(
    null,
  );
  const [previewingNotificationTone, setPreviewingNotificationTone] = useState<NotificationAudioTone | null>(null);
  const [submittingLaunchpadTask, setSubmittingLaunchpadTask] = useState(false);
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const [slackComposerDraft, setSlackComposerDraft] = useState('');
  const [slackCommandTarget, setSlackCommandTarget] = useState<SlackCommandTarget>('miniog');
  const [slackComposerFocusToken, setSlackComposerFocusToken] = useState(0);
  const [reviewJobId, setReviewJobId] = useState<string | null>(null);

  const openReview = (jobId: string) => {
    setReviewJobId(jobId);
    setView('review');
    setNavDrawerOpen(false);
  };

  const settingsIncomplete = useMemo(() => {
    return data ? !data.settingsConfigured : false;
  }, [data]);

  const summary = useMemo(() => {
    return {
      active: data?.activeJobs.length ?? 0,
      recent: data?.recentRuns.length ?? 0,
      failures: data?.failures.length ?? 0,
    };
  }, [data]);

  const allRuns = useMemo(() => {
    if (!data) {
      return [] as RunSummary[];
    }

    const map = new Map<string, RunSummary>();
    for (const run of [...data.activeJobs, ...data.recentRuns, ...data.failures]) {
      map.set(run.id, run);
    }
    return Array.from(map.values());
  }, [data]);

  const loadDashboard = async () => {
    const result = await invoke<DashboardData>('get_dashboard_data');
    setData(result);
    setError(null);
  };

  const loadSettings = async () => {
    const result = await invoke<AppSettings>('get_app_settings');
    setSettings(result);
    setError(null);
  };

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const [dashboard, appSettings] = await Promise.all([
          invoke<DashboardData>('get_dashboard_data'),
          invoke<AppSettings>('get_app_settings'),
        ]);
        if (active) {
          setData(dashboard);
          setSettings(appSettings);
          setError(null);
        }
      } catch (err) {
        if (active) {
          setError(String(err));
        }
      }
    };

    void load();
    const interval = window.setInterval(() => {
      void loadDashboard().catch(err => {
        if (active) {
          setError(String(err));
        }
      });
    }, POLL_MS);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const pendingView = readPendingShortcutView();
    const pendingTarget = readPendingShortcutTarget();
    if (pendingView !== 'launchpad') {
      return;
    }

    setView('launchpad');
    if (pendingTarget) {
      setSlackCommandTarget(pendingTarget);
    }
    window.localStorage.removeItem(PENDING_SHORTCUT_VIEW_KEY);
    window.localStorage.removeItem(PENDING_SHORTCUT_TARGET_KEY);
  }, []);

  useEffect(() => {
    applyAppTheme(settings);
  }, [settings]);

  const openLaunchpad = (target: SlackCommandTarget = 'miniog') => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PENDING_SHORTCUT_VIEW_KEY, 'launchpad');
      window.localStorage.setItem(PENDING_SHORTCUT_TARGET_KEY, target);
    }

    setSlackCommandTarget(target);
    setView('launchpad');
    setNavDrawerOpen(false);
    setSlackComposerFocusToken(previous => previous + 1);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.code === 'KeyM') {
        event.preventDefault();
        event.stopPropagation();
        openLaunchpad(toggleSlackCommandTarget(slackCommandTarget));
        return;
      }

      if (event.key === 'Escape') {
        setNavDrawerOpen(false);
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [slackCommandTarget]);

  useEffect(() => {
    if (!data) {
      return;
    }

    const runExists = selectedRunId ? allRuns.some(run => run.id === selectedRunId) : false;
    if (runExists) {
      return;
    }

    const preferred = data.activeJobs[0]?.id ?? data.failures[0]?.id ?? data.recentRuns[0]?.id ?? null;
    setSelectedRunId(preferred);
  }, [allRuns, data, selectedRunId]);

  useEffect(() => {
    let active = true;

    const refreshLogs = async () => {
      if (!selectedRunId) {
        if (active) {
          setSelectedRunLogs([]);
        }
        return;
      }

      try {
        const logs = await invoke<JobLogEntry[]>('get_job_logs', {
          jobId: selectedRunId,
          limit: 1000,
        });
        if (active) {
          setSelectedRunLogs(logs);
          setError(null);
        }
      } catch (err) {
        if (active) {
          setError(String(err));
        }
      }
    };

    void refreshLogs();
    const interval = window.setInterval(() => {
      void refreshLogs();
    }, 2000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRunPipeline(null);
      return;
    }

    invoke('get_pipeline_run', { jobId: selectedRunId })
      .then(result => setSelectedRunPipeline(result))
      .catch(() => setSelectedRunPipeline(null));
  }, [selectedRunId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<string>('sidecar-log', event => {
      const content = formatSidecarLine(event.payload);
      const id = (sidecarLogSeq.current += 1);
      setLiveSidecarLogs(previous => {
        const next = [...previous, { id, content }];
        if (next.length > 400) {
          return next.slice(next.length - 400);
        }
        return next;
      });
    }).then(handler => {
      if (disposed) {
        handler();
      } else {
        unlisten = handler;
      }
    });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<AppNotificationPayload>(APP_NOTIFICATION_EVENT, event => {
      const title = event.payload.title.trim() || 'Watchtower';
      const description = event.payload.body.trim();
      const notify = event.payload.tone === 'success' ? toast.success : toast.error;
      notify(title, {
        description: description || undefined,
      });
    }).then(handler => {
      if (disposed) {
        handler();
      } else {
        unlisten = handler;
      }
    });

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!settings) {
      return;
    }

    setSavingSettings(true);
    setSettingsMessage(null);

    try {
      const result = await invoke<SaveSettingsResponse>('save_app_settings', {
        settings,
      });
      await Promise.all([loadDashboard(), loadSettings()]);

      setSettingsMessage(
        result.configured
          ? 'Settings saved. Runtime config is complete and the sidecar should boot automatically.'
          : 'Saved, but config is still incomplete. Fill all required fields.',
      );
    } catch (err) {
      setSettingsMessage(`Failed to save settings: ${String(err)}`);
    } finally {
      setSavingSettings(false);
    }
  };

  const navigateToView = (nextView: AppView) => {
    setView(nextView);
    setNavDrawerOpen(false);
  };

  const submitLaunchpadTask = async () => {
    if (slackCommandTarget !== 'miniog') {
      return;
    }

    setSubmittingLaunchpadTask(true);

    try {
      const result = await invoke<LaunchpadSubmitResponse>('submit_launchpad_task', {
        target: slackCommandTarget,
        prompt: slackComposerDraft,
      });

      setSlackComposerDraft('');
      toast.success('miniOG task queued', {
        description: `Request ${result.requestId.slice(0, 8)} is queued. Completion will arrive in the bot DM and as a desktop notification.`,
      });
    } catch (err) {
      toast.error('miniOG task failed to queue', {
        description: String(err),
      });
    } finally {
      setSubmittingLaunchpadTask(false);
    }
  };

  const previewNotification = async (tone: NotificationAudioTone) => {
    if (!settings) {
      return;
    }

    setPreviewingNotificationTone(tone);

    try {
      await invoke('emit_preview_notification', { settings, tone });
    } catch (err) {
      toast.error('Preview notification failed', {
        description: String(err),
      });
    } finally {
      setPreviewingNotificationTone(null);
    }
  };

  const importNotificationAudio = async (tone: NotificationAudioTone, file: File) => {
    if (!settings) {
      return;
    }

    if (file.size === 0) {
      setSettingsMessage('Failed to import notification audio: selected file is empty.');
      return;
    }

    if (file.size > NOTIFICATION_AUDIO_MAX_BYTES) {
      setSettingsMessage('Failed to import notification audio: file must be 10MB or smaller.');
      return;
    }

    setUploadingNotificationAudioTone(tone);
    setSettingsMessage(null);

    try {
      const dataBase64 = await readFileAsBase64(file);
      const result = await invoke<ImportNotificationAudioResponse>('import_notification_audio', {
        fileName: file.name,
        dataBase64,
      });

      setSettings(current => (current ? applyNotificationAudioImport(current, tone, result.path) : current));
      setSettingsMessage(
        `Imported ${result.fileName} for ${tone} notifications. Save settings to apply it to live notifications.`,
      );
    } catch (err) {
      setSettingsMessage(`Failed to import notification audio: ${String(err)}`);
    } finally {
      setUploadingNotificationAudioTone(null);
    }
  };

  if (error && !data && !settings) {
    return (
      <main className="error-view">
        <section className="surface-card">
          <span className="eyebrow">Startup Error</span>
          <h1>Watchtower</h1>
          <p className="error">{error}</p>
        </section>
      </main>
    );
  }

  return (
    <AppShell
      currentView={view}
      failuresCount={summary.failures}
      navDrawerOpen={navDrawerOpen}
      onNavigate={navigateToView}
      onToggleNavDrawer={() => setNavDrawerOpen(open => !open)}
      settingsRequired={settingsIncomplete}
      sidecarStatus={data?.sidecarStatus ?? 'starting'}
    >
      {error ? <div className="inline-error-banner">{error}</div> : null}

      {view === 'overview' ? (
        <OverviewPage
          data={data}
          onOpenIntelligence={() => navigateToView('intelligence')}
          onOpenRuns={() => navigateToView('runs')}
          onOpenSettings={() => navigateToView('settings')}
          onSelectRun={setSelectedRunId}
        />
      ) : null}

      {view === 'launchpad' ? (
        <LaunchpadPage
          draft={slackComposerDraft}
          focusToken={slackComposerFocusToken}
          onDraftChange={setSlackComposerDraft}
          onSubmit={submitLaunchpadTask}
          onTargetChange={setSlackCommandTarget}
          settingsRequired={settingsIncomplete}
          submitting={submittingLaunchpadTask}
          target={slackCommandTarget}
        />
      ) : null}

      {view === 'runs' ? (
        <RunsPage
          data={data}
          onReviewChanges={openReview}
          onSelectRun={setSelectedRunId}
          onRefresh={loadDashboard}
          selectedRunId={selectedRunId}
          selectedRunLogs={selectedRunLogs}
          selectedRunPipeline={selectedRunPipeline}
        />
      ) : null}

      {view === 'intelligence' ? <IntelligencePage data={data} /> : null}

      {view === 'performance' ? (
        <PerformancePage onSelectRun={setSelectedRunId} onNavigateRuns={() => navigateToView('runs')} />
      ) : null}

      {view === 'dossiers' ? <DossierPage /> : null}

      {view === 'diagnostics' ? (
        <div className="page-stack">
          <header className="page-intro">
            <div className="page-intro-copy">
              <span className="eyebrow">Live Stream</span>
              <h1>Diagnostics</h1>
              <p className="page-description">
                Buffered sidecar stdout and stderr. Stays visible while you move through the rest of the app.
              </p>
            </div>
            <div className="page-intro-visual" aria-hidden="true">
              <span className="page-intro-ring page-intro-ring-outer" />
              <span className="page-intro-ring page-intro-ring-mid" />
              <span className="page-intro-ring page-intro-ring-inner" />
              <span className="page-intro-core" />
            </div>
          </header>
          <section className="surface-card">
            <div className="section-head">
              <div className="section-heading-copy">
                <div className="section-title-row">
                  <h2>Live Sidecar Stream</h2>
                  <span className="section-count">{liveSidecarLogs.length}</span>
                </div>
              </div>
            </div>
            <LiveLogConsole lines={liveSidecarLogs} />
          </section>
        </div>
      ) : null}

      {view === 'review' && reviewJobId ? (
        <ReviewPage
          jobId={reviewJobId}
          onBack={() => {
            setView('runs');
            setReviewJobId(null);
          }}
        />
      ) : null}

      {view === 'settings' ? (
        <SettingsPage
          onSettingsChange={nextSettings => setSettings(nextSettings)}
          onImportNotificationAudio={importNotificationAudio}
          onPreviewNotification={previewNotification}
          onSubmit={saveSettings}
          previewingNotificationTone={previewingNotificationTone}
          savingSettings={savingSettings}
          settings={settings}
          settingsConfigured={data?.settingsConfigured ?? false}
          settingsMessage={settingsMessage}
          uploadingNotificationAudioTone={uploadingNotificationAudioTone}
        />
      ) : null}
    </AppShell>
  );
}

export default App;
