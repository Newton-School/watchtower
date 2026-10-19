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
 * point in a job; a click nothing is waiting on is answered as such.
 *
 * Buttons are off until the Slack app has Interactivity enabled (a click on
 * a button the app cannot receive shows the person an error). The operator
 * turns them on with the `slack_buttons` sidecar_state key set to `on`.
 */

export const BUTTON_ACTION_RE = /^miniog_(approve|stop|confirm|decline)$/;

/** How long a recorded click and a prompt's text are kept: longer than any gate waits. */
const RETENTION_MS = 24 * 3_600_000;

/** Clicks by the prompt they sat on (`channel|promptTs`); a prompt's ts is unique in its channel. */
const clicksByPrompt = new Map<string, ThreadMessage[]>();
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

interface ButtonSettings {
  /** The operator's switch, read on every use so it can be flipped without a restart. */
  isEnabled: () => boolean;
  /** Hands a Stop to the stop lane; resolves false when no job was there to stop. */
  onStopClick?: (click: ButtonClick) => Promise<boolean>;
  /** Whether a job still owns the thread, so a click has something to reach. */
  hasListener?: (click: ButtonClick) => boolean;
  /** Tells the person a click reached nothing. */
  onOrphanClick?: (click: ButtonClick) => Promise<void>;
}

let settings: ButtonSettings = { isEnabled: () => false };

export function configureButtons(options: ButtonSettings): void {
  settings = options;
}

export function buttonsEnabled(): boolean {
  try {
    return settings.isEnabled();
  } catch {
    return false;
  }
}

function promptKey(channelId: string, promptTs: string): string {
  return `${channelId}|${promptTs}`;
}

function prune(now: number): void {
  const cutoffTs = (now - RETENTION_MS) / 1000;
  for (const [key, list] of clicksByPrompt) {
    const kept = list.filter(click => Number(click.ts) >= cutoffTs);
    if (kept.length === 0) clicksByPrompt.delete(key);
    else if (kept.length !== list.length) clicksByPrompt.set(key, kept);
  }
  for (const [key, entry] of promptTexts) {
    if (entry.at < now - RETENTION_MS) promptTexts.delete(key);
  }
}

/** A prompt that carries buttons: its text is kept so the buttons can be retired later. */
export function rememberPrompt(params: { channelId: string; ts: string; text: string; now?: number }): void {
  const now = params.now ?? Date.now();
  prune(now);
  promptTexts.set(promptKey(params.channelId, params.ts), { text: params.text, at: now });
}

/**
 * Posts a gate prompt: with its buttons when the switch is on, remembered so
 * the gate can retire them. Returns the prompt's ts, or undefined when the
 * post failed. One place for every gate, so they all behave the same.
 */
export async function postGatePrompt(
  slack: Pick<WebClient, 'chat'>,
  params: { channel: string; thread_ts: string; text: string; blocks: () => KnownBlock[] },
): Promise<string | undefined> {
  const withButtons = buttonsEnabled();
  const result = await slack.chat.postMessage({
    channel: params.channel,
    thread_ts: params.thread_ts,
    text: params.text,
    ...(withButtons ? { blocks: params.blocks() } : {}),
  });
  const ts = typeof result.ts === 'string' ? result.ts : undefined;
  if (withButtons && ts) rememberPrompt({ channelId: params.channel, ts, text: params.text });
  return ts;
}

/** A click, kept as the reply the person would have typed, at Slack's time for it. */
export function recordButtonReply(params: {
  channelId: string;
  messageTs: string;
  userId: string;
  value: string;
  actionTs?: string;
  now?: number;
}): ThreadMessage {
  const now = params.now ?? Date.now();
  prune(now);
  const ts = params.actionTs && Number.isFinite(Number(params.actionTs)) ? params.actionTs : (now / 1000).toFixed(6);
  const reply: ThreadMessage = { text: params.value, user: params.userId, ts };
  const key = promptKey(params.channelId, params.messageTs);
  clicksByPrompt.set(key, [...(clicksByPrompt.get(key) ?? []), reply]);
  return reply;
}

/** Clicks on the prompt posted at `promptTs`, after it, oldest first. */
export function buttonRepliesSince(channelId: string, promptTs: string): ThreadMessage[] {
  const list = clicksByPrompt.get(promptKey(channelId, promptTs)) ?? [];
  return list.filter(click => Number(click.ts) > Number(promptTs)).sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** Thread messages and clicks together, in time order: a reply that came first is read first. */
export function withButtonReplies(messages: ThreadMessage[], channelId: string, promptTs: string): ThreadMessage[] {
  return [...messages, ...buttonRepliesSince(channelId, promptTs)].sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** Slack errors that mean the prompt is gone: nothing left to retire. */
const PROMPT_GONE = new Set(['message_not_found', 'channel_not_found', 'thread_not_found']);

/**
 * The gate ended: the prompt loses its buttons and says how it ended. A
 * prompt posted without buttons (switch off, an older build) is left alone.
 * A transient Slack failure keeps the prompt remembered, so a later retire
 * can still take the buttons away. Never throws.
 */
export async function retirePrompt(params: {
  slack: Pick<WebClient, 'chat'>;
  channelId: string;
  promptTs: string;
  outcome: string;
}): Promise<void> {
  const key = promptKey(params.channelId, params.promptTs);
  const entry = promptTexts.get(key);
  if (!entry) return;
  try {
    await params.slack.chat.update({
      channel: params.channelId,
      ts: params.promptTs,
      text: `${entry.text}\n_${params.outcome}_`,
      blocks: [],
    });
    promptTexts.delete(key);
  } catch (error) {
    const code = (error as { data?: { error?: unknown } } | undefined)?.data?.error;
    if (typeof code === 'string' && PROMPT_GONE.has(code)) promptTexts.delete(key);
  }
}

/**
 * Runs a gate's wait and retires its prompt when the wait ends. `line` says
 * how it ended, or undefined to leave the buttons in place (a pause: the
 * same prompt is resumed later).
 */
export async function withRetire<T>(
  wait: () => Promise<T>,
  params: {
    slack: Pick<WebClient, 'chat'>;
    channelId: string;
    promptTs: string;
    line: (result: T) => string | undefined;
  },
): Promise<T> {
  const result = await wait();
  const line = params.line(result);
  if (line !== undefined) {
    await retirePrompt({ slack: params.slack, channelId: params.channelId, promptTs: params.promptTs, outcome: line });
  }
  return result;
}

export function __resetButtonRepliesForTests(): void {
  clicksByPrompt.clear();
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
 * What a click does: a Stop goes to the stop lane, which aborts the job at
 * any point; a click on a prompt no job is waiting on is answered as such;
 * the others are kept for the gate that is polling.
 */
export async function handleButtonClick(click: ButtonClick): Promise<void> {
  if (click.actionId === 'miniog_stop' && settings.onStopClick) {
    if (await settings.onStopClick(click).catch(() => false)) return;
  }
  if (settings.hasListener && !settings.hasListener(click)) {
    await settings.onOrphanClick?.(click).catch(() => undefined);
    return;
  }
  recordButtonReply({
    channelId: click.channelId,
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

/** A yes-or-no question (merge despite unresolved comments?): No turns it down, it does not stop the job. */
export function yesNoBlocks(text: string): KnownBlock[] {
  return promptBlocks(text, 'miniog_yes_no', [
    button('miniog_approve', 'Yes', 'yes', 'primary'),
    button('miniog_decline', 'No', 'no'),
  ]);
}

/** A confirmation prompt (merge, deploy) with the exact phrase as a button, and Cancel. */
export function confirmationBlocks(text: string, phrase: string, label: string): KnownBlock[] {
  return promptBlocks(text, 'miniog_confirmation', [
    button('miniog_confirm', label, phrase, 'primary'),
    button('miniog_decline', 'Cancel', 'cancel'),
  ]);
}
