import type { KnownBlock } from '@slack/web-api';
import type { ThreadMessage } from './threadContext.js';

/**
 * Buttons on miniOG's gates (suggestion 9 of the 2026-10-18 UX exploration).
 *
 * Every gate used to be a typed phrase: "yes" on a plan, "confirm merge",
 * "confirm deploy". Phrases break on formatting and on the footer a
 * forwarding app adds, and a non-engineer has to know them. A button click
 * arrives as a `block_actions` payload over Socket Mode; it is recorded here
 * as if the person had typed the phrase, and the gates that poll the thread
 * read these replies beside the real ones. Nothing else about the gates
 * changes: who may approve, confirm or stop is still decided by the gate.
 *
 * Buttons are off until the Slack app has Interactivity enabled (a click on
 * a button the app cannot receive shows the person an error). The operator
 * turns them on with the `slack_buttons` sidecar_state key set to `on`.
 */

export const BUTTON_ACTION_RE = /^miniog_(approve|stop|confirm|decline)$/;

/** How long a recorded click is kept: longer than any gate waits. */
const RETENTION_MS = 24 * 3_600_000;

const repliesByThread = new Map<string, ThreadMessage[]>();
let enabled: () => boolean = () => false;

/** The operator's switch, read on every use so it can be flipped without a restart. */
export function configureButtons(options: { isEnabled: () => boolean }): void {
  enabled = options.isEnabled;
}

export function buttonsEnabled(): boolean {
  try {
    return enabled();
  } catch {
    return false;
  }
}

function threadKey(channelId: string, threadTs: string): string {
  return `${channelId}|${threadTs}`;
}

function prune(now: number): void {
  const cutoff = (now - RETENTION_MS) / 1000;
  for (const [key, list] of repliesByThread) {
    const kept = list.filter(reply => Number(reply.ts) >= cutoff);
    if (kept.length === 0) repliesByThread.delete(key);
    else if (kept.length !== list.length) repliesByThread.set(key, kept);
  }
}

/** A click, kept as the reply the person would have typed. */
export function recordButtonReply(params: {
  channelId: string;
  threadTs: string;
  userId: string;
  value: string;
  now?: number;
}): ThreadMessage {
  const now = params.now ?? Date.now();
  prune(now);
  // A Slack ts is seconds with a fraction; the gates compare it to the prompt's ts.
  const reply: ThreadMessage = { text: params.value, user: params.userId, ts: (now / 1000).toFixed(6) };
  const key = threadKey(params.channelId, params.threadTs);
  repliesByThread.set(key, [...(repliesByThread.get(key) ?? []), reply]);
  return reply;
}

/** Clicks in a thread after `afterTs`, oldest first. */
export function buttonRepliesSince(channelId: string, threadTs: string, afterTs: string): ThreadMessage[] {
  const list = repliesByThread.get(threadKey(channelId, threadTs)) ?? [];
  return list.filter(reply => Number(reply.ts) > Number(afterTs));
}

export function __resetButtonRepliesForTests(): void {
  repliesByThread.clear();
  enabled = () => false;
}

/** The payload a click sends, reduced to what the gates need. */
export interface ButtonClick {
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  actionId: string;
  value: string;
  /** The prompt's text, so the message can be rewritten without the buttons. */
  messageText: string;
}

/** Reads a Bolt `block_actions` body; undefined when it is not one of miniOG's buttons. */
export function readButtonClick(body: Record<string, unknown>): ButtonClick | undefined {
  const actions = Array.isArray(body.actions) ? (body.actions as Array<Record<string, unknown>>) : [];
  const action = actions[0];
  const actionId = typeof action?.action_id === 'string' ? action.action_id : '';
  if (!BUTTON_ACTION_RE.test(actionId)) return undefined;
  const value = typeof action?.value === 'string' ? action.value : '';
  const channel = body.channel as Record<string, unknown> | undefined;
  const message = body.message as Record<string, unknown> | undefined;
  const user = body.user as Record<string, unknown> | undefined;
  const channelId = typeof channel?.id === 'string' ? channel.id : '';
  const messageTs = typeof message?.ts === 'string' ? message.ts : '';
  const threadTs = typeof message?.thread_ts === 'string' ? message.thread_ts : messageTs;
  const userId = typeof user?.id === 'string' ? user.id : '';
  if (!channelId || !messageTs || !userId || !value) return undefined;
  return {
    channelId,
    threadTs,
    messageTs,
    userId,
    actionId,
    value,
    messageText: typeof message?.text === 'string' ? message.text : '',
  };
}

function button(actionId: string, label: string, value: string, style?: 'primary' | 'danger') {
  return {
    type: 'button' as const,
    action_id: actionId,
    text: { type: 'plain_text' as const, text: label, emoji: false },
    value,
    ...(style ? { style } : {}),
  };
}

/** The plan prompt with Approve and Stop. Changes are still typed: a button cannot carry them. */
export function approvalBlocks(text: string): KnownBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      block_id: 'miniog_approval',
      elements: [
        button('miniog_approve', 'Approve', 'yes', 'primary'),
        button('miniog_stop', 'Stop', 'stop', 'danger'),
      ],
    },
  ];
}

/** A confirmation prompt (merge, deploy) with the exact phrase as a button, and Cancel. */
export function confirmationBlocks(text: string, phrase: string, label: string): KnownBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      block_id: 'miniog_confirmation',
      elements: [button('miniog_confirm', label, phrase, 'primary'), button('miniog_decline', 'Cancel', 'cancel')],
    },
  ];
}

/** The prompt once a button was clicked: the same text, the choice, no buttons. */
export function clickedText(messageText: string, userId: string, actionId: string): string {
  const choice =
    actionId === 'miniog_approve'
      ? 'approved'
      : actionId === 'miniog_stop'
        ? 'stopped it'
        : actionId === 'miniog_confirm'
          ? 'confirmed'
          : 'cancelled';
  return `${messageText}\n_<@${userId}> ${choice} with a button._`;
}
