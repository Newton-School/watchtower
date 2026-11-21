import type { PersonalItem } from '../state/personalStore.js';

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The line the end-of-run notification says, so it's worth opening: what needs
 * him, what's ready to send, and what miniOG is about to take on by itself.
 * `startsItself` says which items the run's work will pick up without him.
 */
export function inboxReadyLine(
  items: PersonalItem[],
  startsItself: (item: PersonalItem) => boolean,
  now = Date.now(),
): string {
  const open = items.filter(
    item =>
      item.source !== 'session' &&
      item.state !== 'done' &&
      !item.ownerClosed &&
      !(item.snoozedUntil && Date.parse(item.snoozedUntil) > now),
  );
  const onIt = open.filter(item => item.state === 'needs_you' && startsItself(item)).length;
  const needsYou = open.filter(item => item.state === 'needs_you').length - onIt;
  const replies = open.filter(item => item.state === 'ready').length;
  const parts = [
    needsYou > 0 ? `${needsYou} need${needsYou === 1 ? 's' : ''} you` : '',
    replies > 0 ? `${count(replies, 'reply', 'replies')} to send` : '',
  ].filter(Boolean);
  const head = parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing needs you.';
  const line = onIt > 0 ? `${head} miniOG is starting on ${onIt} more.` : head;
  return line.charAt(0).toUpperCase() + line.slice(1);
}
