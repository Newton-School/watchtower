import type { KnownBlock, WebClient } from '@slack/web-api';
import type { ThreadMessage } from './threadContext.js';

/**
 * Buttons on miniOG's gates (suggestion 9 of the 2026-10-18 UX exploration).
 *
 * Every gate used to be a typed phrase: "yes" on a plan, "confirm merge",
 * "confirm deploy". Phrases break on formatting and on the footer a
 * forwarding app adds, and a non-engineer has to know them. A button click
 * arrives as a `block_actions` payload over Socket Mode; it is recorded here
 * as if the person had typed the phrase, keyed to the prompt it was clicked
 * on, and the gate that polls the thread reads it beside the real replies.
 * Nothing else about the gates changes: who may approve, confirm or stop is
 * still decided by the gate, which also retires the prompt's buttons when it
 * ends, whatever ended it, so a dead prompt cannot be clicked into looking
 * acted on. A Stop click goes through the stop lane, which works at any
 * point in a job, not only while a gate is polling.
 *
 * Buttons are off until the Slack app has Interactivity enabled (a click on
 * a button the app cannot receive shows the person an error). The operator
 * turns them on with the `slack_buttons` sidecar_state key set to `on`.
 */

export const BUTTON_ACTION_RE = /^miniog_(approve|stop|confirm|decline)$/;

/** How long a recorded click and a prompt's text are kept: longer than any gate waits. */
const RETENTION_MS = 24 * 3_600_000;

interface RecordedClick extends ThreadMessage {
  /** The prompt the button sat on. A click on an older prompt is not a reply to a newer one. */
  messageTs: string;
}

const clicksByThread = new Map<string, RecordedClick[]>();
/** The text each prompt was posted with, so it can be rewritten without its buttons. */
const promptTexts = new Map<string, { text: string; at: number }>();

export interface ButtonClick {
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  actionId: string;
  value: string;
  /** Slack's own time for the click, on the same clock as message timestamps. */
  actionTs: string;
}

let settings: { isEnabled: () => boolean; onStopClick?: (click: ButtonClick) => Promise<boolean> } = {
  isEnabled: () => false,
};

/**
 * The operator's switch, read on every use so it can be flipped without a
 * restart, and the stop lane a Stop click is handed to.
 */
export function configureButtons(options: {
  isEnabled: () => boolean;
  /** Hands a Stop to the stop lane; resolves false when no job was there to stop. */
  onStopClick?: (click: ButtonClick) => Promise<boolean>;
}): void {
  settings = options;
}

export function buttonsEnabled(): boolean {
  try {
    return settings.isEnabled();
  } catch {
    return false;
  }
}

export function stopClickHandler(): ((click: ButtonClick) => Promise<boolean>) | undefined {
  return settings.onStopClick;
}

function threadKey(channelId: string, threadTs: string): string {
  return `${channelId}|${threadTs}`;
}

function prune(now: number): void {
  const cutoffTs = (now - RETENTION_MS) / 1000;
  for (const [key, list] of clicksByThread) {
    const kept = list.filter(click => Number(click.ts) >= cutoffTs);
    if (kept.length === 0) clicksByThread.delete(key);
    else if (kept.length !== list.length) clicksByThread.set(key, kept);
  }
  for (const [key, entry] of promptTexts) {
    if (entry.at < now - RETENTION_MS) promptTexts.delete(key);
  }
}

/** A prompt that carries buttons: its text is kept so the buttons can be retired later. */
export function rememberPrompt(params: { channelId: string; ts: string; text: string; now?: number }): void {
  const now = params.now ?? Date.now();
  prune(now);
  promptTexts.set(`${params.channelId}|${params.ts}`, { text: params.text, at: now });
}

/** A click, kept as the reply the person would have typed, at Slack's time for it. */
export function recordButtonReply(params: {
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  value: string;
  actionTs?: string;
  now?: number;
}): ThreadMessage {
  const now = params.now ?? Date.now();
  prune(now);
  const ts = params.actionTs && Number.isFinite(Number(params.actionTs)) ? params.actionTs : (now / 1000).toFixed(6);
  const click: RecordedClick = { text: params.value, user: params.userId, ts, messageTs: params.messageTs };
  const key = threadKey(params.channelId, params.threadTs);
  clicksByThread.set(key, [...(clicksByThread.get(key) ?? []), click]);
  return { text: click.text, user: click.user, ts: click.ts };
}

/** Clicks on the prompt posted at `promptTs`, after it, oldest first. */
export function buttonRepliesSince(channelId: string, threadTs: string, promptTs: string): ThreadMessage[] {
  const list = clicksByThread.get(threadKey(channelId, threadTs)) ?? [];
  return list
    .filter(click => click.messageTs === promptTs && Number(click.ts) > Number(promptTs))
    .map(({ text, user, ts }) => ({ text, user, ts }));
}

/**
 * The gate ended: the prompt loses its buttons and says how it ended. A
 * prompt posted without buttons (switch off, or by an older build) is left
 * alone. Never throws.
 */
export async function retirePrompt(params: {
  slack: Pick<WebClient, 'chat'>;
  channelId: string;
  promptTs: string;
  outcome: string;
}): Promise<void> {
  const entry = promptTexts.get(`${params.channelId}|${params.promptTs}`);
  if (!entry) return;
  promptTexts.delete(`${params.channelId}|${params.promptTs}`);
  try {
    await params.slack.chat.update({
      channel: params.channelId,
      ts: params.promptTs,
      text: `${entry.text}\n_${params.outcome}_`,
      blocks: [],
    });
  } catch {
    // The prompt may have been deleted; nothing to retire.
  }
}

export function __resetButtonRepliesForTests(): void {
  clicksByThread.clear();
  promptTexts.clear();
  settings = { isEnabled: () => false };
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
  const actionTs = typeof action?.action_ts === 'string' ? action.action_ts : (Date.now() / 1000).toFixed(6);
  return { channelId, threadTs, messageTs, userId, actionId, value, actionTs };
}

/**
 * What a click does: a Stop goes to the stop lane, which aborts the job at any
 * point; the others are kept for the gate that is polling.
 */
export async function handleButtonClick(click: ButtonClick): Promise<void> {
  if (click.actionId === 'miniog_stop') {
    const onStop = stopClickHandler();
    if (onStop && (await onStop(click).catch(() => false))) return;
  }
  recordButtonReply({
    channelId: click.channelId,
    threadTs: click.threadTs,
    messageTs: click.messageTs,
    userId: click.userId,
    value: click.value,
    actionTs: click.actionTs,
  });
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

function promptBlocks(text: string, blockId: string, elements: ReturnType<typeof button>[]): KnownBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'actions', block_id: blockId, elements },
  ];
}

/** The plan prompt with Approve and Stop. Changes are still typed: a button cannot carry them. */
export function approvalBlocks(text: string): KnownBlock[] {
  return promptBlocks(text, 'miniog_approval', [
    button('miniog_approve', 'Approve', 'yes', 'primary'),
    button('miniog_stop', 'Stop', 'stop', 'danger'),
  ]);
}

/** A confirmation prompt (merge, deploy) with the exact phrase as a button, and Cancel. */
export function confirmationBlocks(text: string, phrase: string, label: string): KnownBlock[] {
  return promptBlocks(text, 'miniog_confirmation', [
    button('miniog_confirm', label, phrase, 'primary'),
    button('miniog_decline', 'Cancel', 'cancel'),
  ]);
}
