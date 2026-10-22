import type { WebClient } from '@slack/web-api';
import { notifyDesktop } from '../notify/desktopNotifier.js';
import type { SlackEventEnvelope, WorkflowResult, WorkflowStepLogger } from '../types/contracts.js';

type LaunchpadStore = {
  markLaunchpadRequestRunning: (input: { id: string; jobId: string }) => void;
  markLaunchpadRequestFinished: (input: {
    id: string;
    status: 'SUCCESS' | 'FAILED' | 'PAUSED' | 'SKIPPED';
    result?: Record<string, unknown>;
    errorMessage?: string;
  }) => void;
  /**
   * Optional dossier accessor; when present, finalize/fail evict the user's
   * cached dossier so the next read recomputes the rollup. Optional so test
   * stores don't have to construct a real DossierStore.
   */
  dossierStore?: () => { invalidate: (userId: string) => void };
};

function fallbackCompletionText(message: string): string {
  const trimmed = message.trim();
  return trimmed || 'miniOG task finished.';
}

export function markLaunchpadJobCreated(params: {
  event: SlackEventEnvelope;
  jobId: string;
  store: LaunchpadStore;
  logStep?: WorkflowStepLogger;
}): void {
  const { event, jobId, store, logStep } = params;
  if (!event.launchpadRequestId) {
    return;
  }

  store.markLaunchpadRequestRunning({
    id: event.launchpadRequestId,
    jobId,
  });

  logStep?.({
    stage: 'launchpad.request.running',
    message: 'Linked launchpad request to job execution.',
    data: {
      requestId: event.launchpadRequestId,
      jobId,
    },
  });
}

export async function finalizeLaunchpadWorkflowResult(params: {
  event: SlackEventEnvelope;
  result: WorkflowResult;
  slack: WebClient;
  store: LaunchpadStore;
  logStep?: WorkflowStepLogger;
}): Promise<void> {
  const { event, result, slack, store, logStep } = params;
  if (!event.launchpadRequestId) {
    return;
  }

  let fallbackPosted = false;
  // A stopped or skipped run has nothing to report: a stop was already
  // announced, and a skip ("staying silent") must stay silent.
  const reportable = result.status !== 'CANCELLED' && result.status !== 'SKIPPED';
  if (!result.slackPosted && reportable) {
    const text = fallbackCompletionText(result.message);
    try {
      await slack.chat.postMessage({
        channel: event.channelId,
        thread_ts: event.threadTs,
        text,
      });
      fallbackPosted = true;
      logStep?.({
        stage: 'launchpad.slack.fallback_posted',
        message: 'Posted fallback completion reply for launchpad task.',
        data: {
          requestId: event.launchpadRequestId,
          status: result.status,
        },
      });
    } catch (error) {
      logStep?.({
        stage: 'launchpad.slack.fallback_failed',
        message: 'Failed to post fallback completion reply for launchpad task.',
        level: 'WARN',
        data: {
          requestId: event.launchpadRequestId,
          error: String(error),
        },
      });
    }
  }

  // Map CANCELLED to FAILED for launchpad status (launchpad does not have a CANCELLED state)
  const launchpadStatus = result.status === 'CANCELLED' ? ('FAILED' as const) : result.status;
  store.markLaunchpadRequestFinished({
    id: event.launchpadRequestId,
    status: launchpadStatus,
    result: result.result,
    errorMessage: result.status === 'FAILED' || result.status === 'CANCELLED' ? result.message : undefined,
  });

  // Drop the dossier LRU entry: a job just completed, so the next dossier read
  // should re-probe learning_signals and recompute affinity/metrics.
  if (event.userId && store.dossierStore) {
    try {
      store.dossierStore().invalidate(event.userId);
    } catch {
      // never let cache invalidation block the lifecycle
    }
  }

  logStep?.({
    stage: 'launchpad.request.completed',
    message: 'Marked launchpad request with terminal workflow status.',
    data: {
      requestId: event.launchpadRequestId,
      status: result.status,
      slackPosted: result.slackPosted || fallbackPosted,
    },
  });

  if (result.status === 'SUCCESS') {
    notifyDesktop('Watchtower miniOG complete', fallbackCompletionText(result.message), 'success');
    logStep?.({
      stage: 'launchpad.notify.success',
      message: 'Emitted success notification for launchpad miniOG task.',
      data: {
        requestId: event.launchpadRequestId,
      },
    });
  }
}

export function failLaunchpadWorkflow(params: {
  event: SlackEventEnvelope;
  errorMessage: string;
  store: LaunchpadStore;
  logStep?: WorkflowStepLogger;
}): void {
  const { event, errorMessage, store, logStep } = params;
  if (!event.launchpadRequestId) {
    return;
  }

  store.markLaunchpadRequestFinished({
    id: event.launchpadRequestId,
    status: 'FAILED',
    errorMessage,
  });

  logStep?.({
    stage: 'launchpad.request.failed',
    message: 'Marked launchpad request as failed.',
    level: 'WARN',
    data: {
      requestId: event.launchpadRequestId,
      errorMessage,
    },
  });
}
