import type { ReactNode } from 'react';
import { emojiChar } from './emoji';
import type { SlackUser } from '../types';

// One inline token at a time: <...> links and mentions, `code`, *bold*,
// _italic_, ~strike~ and :emoji:. Bold, italic and strike need a word
// boundary on both sides, like Slack, so snake_case and 2*3*4 stay as text.
// The boundary before is a captured character rather than a lookbehind, which
// older macOS WebKit can't parse.
const INLINE =
  /<([^<>\n]+)>|`([^`\n]+)`|(^|[^\w*])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?![\w*])|(^|[^\w_])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![\w_])|(^|[^\w~])~([^\s~](?:[^~\n]*?[^\s~])?)~(?![\w~])|:([a-z0-9_+'-]+(?:::skin-tone-[2-6])?):/g;

// Mention, channel and link tokens, which Slack text keeps as markup.
const SLACK_TOKEN = /<(?:[@#!][^<>\s|]+|(?:https?|mailto):[^<>\s|]+)(?:\|[^<>]*)?>/g;

function decode(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function escapeMarkup(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Text typed in the app, ready for Slack: &, < and > escaped, except inside mention and link tokens. */
export function toSlackText(input: string): string {
  let out = '';
  let last = 0;
  for (const match of input.matchAll(SLACK_TOKEN)) {
    const start = match.index ?? 0;
    out += escapeMarkup(input.slice(last, start)) + match[0];
    last = start + match[0].length;
  }
  return out + escapeMarkup(input.slice(last));
}

/** Slack text as someone would type it, for editing. */
export function fromSlackText(text: string): string {
  return decode(text);
}

function renderAngle(body: string, users: Record<string, SlackUser>, key: string): ReactNode {
  const bar = body.indexOf('|');
  const target = bar === -1 ? body : body.slice(0, bar);
  // An empty label (`<#C123|>`) means "no label", as in Slack.
  const label = bar === -1 ? undefined : body.slice(bar + 1) || undefined;
  if (target.startsWith('@')) {
    const id = target.slice(1);
    return (
      <span key={key} className="slack-mention">
        @{label ?? users[id]?.name ?? id}
      </span>
    );
  }
  if (target.startsWith('#')) {
    return (
      <span key={key} className="slack-mention">
        #{label ?? target.slice(1)}
      </span>
    );
  }
  if (target.startsWith('!')) {
    const special = target.slice(1);
    const text = label ?? (special.startsWith('subteam^') ? 'group' : special.split('^')[0]);
    return (
      <span key={key} className="slack-mention">
        {special.startsWith('date^') ? decode(label ?? '') : `@${text.replace(/^@/, '')}`}
      </span>
    );
  }
  const href = decode(target);
  return (
    <a key={key} className="slack-link" href={href} target="_blank" rel="noopener noreferrer">
      {decode(label ?? target.replace(/^mailto:/, ''))}
    </a>
  );
}

function renderInline(text: string, users: Record<string, SlackUser>, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(decode(text.slice(last, start)));
    const key = `${keyPrefix}-${index++}`;
    const [whole, angle, code, boldBefore, bold, italicBefore, italic, strikeBefore, strike, emoji] = match;
    const before = boldBefore ?? italicBefore ?? strikeBefore;
    if (before) nodes.push(decode(before));
    if (angle !== undefined) nodes.push(renderAngle(angle, users, key));
    else if (code !== undefined) {
      nodes.push(
        <code key={key} className="slack-inline-code">
          {decode(code)}
        </code>,
      );
    } else if (bold !== undefined) nodes.push(<strong key={key}>{renderInline(bold, users, key)}</strong>);
    else if (italic !== undefined) nodes.push(<em key={key}>{renderInline(italic, users, key)}</em>);
    else if (strike !== undefined) nodes.push(<s key={key}>{renderInline(strike, users, key)}</s>);
    else if (emoji !== undefined) {
      const char = emojiChar(emoji);
      nodes.push(
        char ? (
          <span key={key} className="slack-emoji" title={`:${emoji}:`}>
            {char}
          </span>
        ) : (
          whole
        ),
      );
    }
    last = start + whole.length;
  }
  if (last < text.length) nodes.push(decode(text.slice(last)));
  return nodes;
}

function renderLines(text: string, users: Record<string, SlackUser>, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const lines = text.split('\n');
  let quote: string[] = [];
  // A quote is a block of its own, so the line after it needs no <br>.
  let afterBlock = false;
  const flushQuote = (key: string) => {
    if (quote.length === 0) return;
    afterBlock = true;
    const quoted = quote;
    quote = [];
    nodes.push(
      <blockquote key={key} className="slack-quote">
        {quoted.flatMap((line, i) => [
          ...(i > 0 ? [<br key={`${key}-br-${i}`} />] : []),
          ...renderInline(line, users, `${key}-${i}`),
        ])}
      </blockquote>,
    );
  };
  lines.forEach((line, i) => {
    const key = `${keyPrefix}-l${i}`;
    const quoted = /^(&gt;|>) ?/.exec(line);
    if (quoted) {
      quote.push(line.slice(quoted[0].length));
      return;
    }
    flushQuote(`${key}-q`);
    if (nodes.length > 0 && !afterBlock) nodes.push(<br key={`${key}-br`} />);
    afterBlock = false;
    nodes.push(...renderInline(line, users, key));
  });
  flushQuote(`${keyPrefix}-qend`);
  return nodes;
}

/** Slack mrkdwn as React nodes: code blocks, quotes, links, mentions, emoji. */
export function renderSlackText(text: string, users: Record<string, SlackUser>): ReactNode[] {
  const nodes: ReactNode[] = [];
  const parts = text.split('```');
  // An unclosed ``` is just text, as in Slack.
  if (parts.length % 2 === 0) parts.splice(-2, 2, `${parts[parts.length - 2]}\`\`\`${parts[parts.length - 1]}`);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      nodes.push(
        <pre key={`code-${i}`} className="slack-code-block">
          {decode(part.replace(/^\n/, ''))}
        </pre>,
      );
    } else {
      // Code blocks are blocks: drop the newline that sits against one.
      const trimmed = part.replace(i > 0 ? /^\n/ : /^$/, '').replace(i < parts.length - 1 ? /\n$/ : /^$/, '');
      if (trimmed) nodes.push(...renderLines(trimmed, users, `p${i}`));
    }
  });
  return nodes;
}

export function SlackText({ text, users }: { text: string; users: Record<string, SlackUser> }) {
  return <>{renderSlackText(text, users)}</>;
}
