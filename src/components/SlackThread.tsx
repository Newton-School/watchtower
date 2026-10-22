import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  RemoveReactionsResult,
  RunControls,
  RunThread,
  SlackFile,
  SlackMessage,
  SlackUser,
  StartedRun,
  StartedRunStatus,
} from '../types';
import { emojiChar } from '../lib/emoji';
import { SlackText, fromSlackText, toSlackText } from '../lib/slackText';
import { loadSlackImage } from '../lib/slackCache';
import { EmojiPicker } from './EmojiPicker';
import { SlackComposer } from './SlackComposer';
import type { ComposedAsk, ComposedMessage } from './SlackComposer';
import { RunControlsBar, isWaiting } from './RunControlsBar';
import type { StartedRunView } from './RunControlsBar';
import { SectionCard } from './primitives';

const REFRESH_MS = 5000;
// How often to check on a run started from here until miniOG takes it.
const STARTED_POLL_MS = 2000;
// Slack folds a message into the previous one when the same person posts again this soon.
const GROUP_WINDOW_SECONDS = 5 * 60;

type Author = { name: string; avatarUrl: string | null; isBot: boolean };

function authorOf(message: SlackMessage, users: Record<string, SlackUser>): Author {
  const user = message.user ? users[message.user] : undefined;
  const icons = message.bot_profile?.icons;
  return {
    name: user?.name ?? message.bot_profile?.name ?? message.username ?? message.user ?? 'Unknown',
    avatarUrl: user?.avatarUrl ?? icons?.image_72 ?? icons?.image_48 ?? null,
    isBot: Boolean(message.bot_id) || Boolean(user?.isBot),
  };
}

function authorKey(message: SlackMessage): string {
  return message.user ?? message.bot_id ?? message.username ?? '';
}

function messageTime(ts: string): { short: string; full: string } {
  const date = new Date(parseFloat(ts) * 1000);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = date.toDateString() === new Date().toDateString();
  return {
    short: sameDay ? time : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`,
    full: date.toLocaleString(),
  };
}

function describeRemoval(result: RemoveReactionsResult): string {
  const parts: string[] = [];
  if (result.removed.length > 0) {
    parts.push(`Removed ${result.removed.map(name => emojiChar(name) ?? `:${name}:`).join(' ')}`);
  }
  if (result.failed.length > 0) parts.push(`Couldn't remove ${result.failed.join(', ')}`);
  return parts.length > 0 ? `${parts.join('. ')}.` : 'miniOG had no emojis left there.';
}

function submitOnEnter(e: ReactKeyboardEvent<HTMLTextAreaElement>, submit: () => void) {
  // WebKit ends an IME composition before the Enter keydown; keyCode 229 still marks it.
  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    submit();
  }
}

function readAsBase64(file: File): Promise<{ name: string; dataBase64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, dataBase64: String(reader.result).replace(/^data:[^,]*,/, '') });
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.readAsDataURL(file);
  });
}

function isImage(file: SlackFile): boolean {
  return Boolean(file.mimetype?.startsWith('image/') && (file.thumb_360 || file.url_private));
}

/** A Slack-hosted image, fetched through the app (the file is private to the workspace). */
function SlackImage({ file }: { file: SlackFile }) {
  const url = file.thumb_720 ?? file.thumb_480 ?? file.thumb_360 ?? file.url_private ?? '';
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    loadSlackImage(url, file.mimetype ?? '')
      .then(data => current && setSrc(data))
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [url, file.mimetype]);
  const name = file.title || file.name || 'Image';
  if (failed) {
    return (
      <a className="slack-file" href={file.permalink} target="_blank" rel="noopener noreferrer">
        🖼 {name}
      </a>
    );
  }
  const width = Math.min(file.thumb_360_w ?? 360, 360);
  const height = file.thumb_360_w && file.thumb_360_h ? Math.round((width / file.thumb_360_w) * file.thumb_360_h) : 200;
  return (
    <a className="slack-image" href={file.permalink} target="_blank" rel="noopener noreferrer" title={name}>
      {src ? (
        <img src={src} alt={name} onError={() => setFailed(true)} />
      ) : (
        <span className="slack-image-loading" style={{ width, height }} />
      )}
    </a>
  );
}

type SlackThreadProps = {
  jobId: string;
  /** Opens another run's page: a run started from here, or one busy in the thread. */
  onOpenRun?: (jobId: string) => void;
};

/**
 * The run's Slack thread, read live, where the owner acts as miniOG: reply,
 * react, edit or delete miniOG's own messages, stop the run, re-run it, or ask
 * miniOG something new here. Everything done here is logged in the run's
 * trace.
 */
export function SlackThread({ jobId, onOpenRun }: SlackThreadProps) {
  const [thread, setThread] = useState<RunThread | null>(null);
  const [controls, setControls] = useState<RunControls | null>(null);
  const [started, setStarted] = useState<StartedRunView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ ts: string; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<{ ts: string; anchor: HTMLElement } | null>(null);

  // Only the newest read may land, so a slow poll can't overwrite a fresher one.
  const readSeq = useRef(0);
  const polling = useRef(false);
  // A Slack hiccup on a refresh keeps the last good read on screen.
  const hasGoodRead = useRef(false);

  const load = useCallback(
    async (fromPoll = false) => {
      if (fromPoll && polling.current) return;
      const seq = ++readSeq.current;
      if (fromPoll) polling.current = true;
      // The run's own state comes from the app's database: quick, and it
      // lands even when Slack doesn't.
      invoke<RunControls>('get_run_controls', { jobId })
        .then(next => seq === readSeq.current && setControls(next))
        .catch(() => {});
      try {
        const next = await invoke<RunThread>('get_run_thread', { jobId });
        if (seq !== readSeq.current) return;
        if (next.readError?.kind === 'other' && hasGoodRead.current) {
          setLoadError(`Couldn't refresh (Slack said ${next.readError.code}); showing the last read.`);
          return;
        }
        hasGoodRead.current = next.hasThread && !next.readError;
        setThread(next);
        setLoadError(null);
      } catch (err) {
        if (seq === readSeq.current) setLoadError(String(err));
      } finally {
        if (fromPoll) polling.current = false;
      }
    },
    [jobId],
  );

  useEffect(() => {
    hasGoodRead.current = false;
    setThread(null);
    setControls(null);
    setStarted(null);
    setLoadError(null);
    setActionError(null);
    setNotice(null);
    setEditing(null);
    setConfirmDelete(null);
    setPickerFor(null);
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (command: string, args: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    try {
      await invoke(command, { jobId, ...args });
      await load();
      return true;
    } catch (err) {
      setActionError(String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Follow a run started from here until miniOG takes it or turns it down.
  const startedId = started?.requestId ?? null;
  const startedWaiting = started !== null && isWaiting(started.status);
  useEffect(() => {
    if (!startedId || !startedWaiting) return;
    const check = async () => {
      try {
        const status = await invoke<StartedRunStatus>('get_started_run', { requestId: startedId });
        setStarted(current => (current?.requestId === startedId ? { ...current, status } : current));
      } catch {
        // Checked again on the next tick.
      }
    };
    const timer = window.setInterval(() => void check(), STARTED_POLL_MS);
    return () => window.clearInterval(timer);
  }, [startedId, startedWaiting]);

  const startRun = async (
    kind: StartedRunView['kind'],
    command: string,
    args: Record<string, unknown>,
  ): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    try {
      const run = await invoke<StartedRun>(command, { jobId, ...args });
      setStarted({ kind, requestId: run.requestId, status: null });
      await load();
      return true;
    } catch (err) {
      setActionError(String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Keep the newest message in view, as Slack does, unless the reader scrolled up.
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const messageCount = thread?.messages.length ?? 0;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && pinnedToBottom.current) list.scrollTop = list.scrollHeight;
  }, [messageCount]);

  // Escape backs out of an edit or a delete prompt without closing the run
  // page, wherever focus is (WebKit leaves it on the page after a click).
  const canBackOut = editing !== null || confirmDelete !== null;
  useEffect(() => {
    if (!canBackOut) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setEditing(null);
      setConfirmDelete(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [canBackOut]);

  if (thread && !thread.hasThread) return null;

  const sendMessage = async ({ text, broadcast, files }: ComposedMessage): Promise<boolean> => {
    if (files.length === 0) return act('post_as_miniog', { text, broadcast });
    try {
      return act('upload_as_miniog', { text, files: await Promise.all(files.map(readAsBase64)) });
    } catch (err) {
      setActionError(String(err));
      return false;
    }
  };

  const askMiniog = ({ text, postAsk }: ComposedAsk) => startRun('ask', 'ask_miniog_in_thread', { text, postAsk });

  const saveEdit = async () => {
    if (!editing || busy) return;
    if (await act('edit_miniog_message', { ts: editing.ts, text: toSlackText(editing.text) })) setEditing(null);
  };

  const toggleReaction = (message: SlackMessage, name: string) => {
    if (busy) return;
    const mine = message.reactions?.some(r => r.name === name && r.users.includes(thread?.botUserId ?? ''));
    setPickerFor(null);
    void act('set_miniog_reaction', { ts: message.ts, name, add: !mine });
  };

  const togglePicker = (ts: string, anchor: HTMLElement) => {
    setPickerFor(current => (current?.anchor === anchor ? null : { ts, anchor }));
  };

  const title =
    thread?.channelKind === 'im'
      ? 'Direct message'
      : thread?.channelKind === 'mpim'
        ? 'Group message'
        : `#${thread?.channelName ?? thread?.channelId ?? 'slack'}`;
  const replies = thread?.replyCount ?? 0;
  const shown = thread?.truncated ? ` · showing the latest ${Math.max(messageCount - 1, 0)}` : '';
  const actions = thread?.permalink ? (
    <a className="ghost-button" href={thread.permalink} target="_blank" rel="noopener noreferrer">
      Open in Slack ↗
    </a>
  ) : null;

  return (
    <SectionCard
      className="slack-thread-card"
      title={title}
      subtitle={
        thread
          ? `Thread · ${replies} ${replies === 1 ? 'reply' : 'replies'}${shown} · you act as miniOG here`
          : 'Thread'
      }
      actions={actions}
    >
      {thread && controls ? (
        <RunControlsBar
          jobId={jobId}
          controls={controls}
          users={thread.users}
          threadClosed={Boolean(thread.readError)}
          busy={busy}
          started={started}
          onStop={() => act('stop_run', {})}
          onRerun={postAsk => startRun('rerun', 'rerun_in_thread', { postAsk })}
          onDismissStarted={() => setStarted(null)}
          onOpenRun={onOpenRun}
        />
      ) : null}
      {thread?.readError && actionError ? <p className="slack-thread-error">{actionError}</p> : null}
      {loadError && !thread ? (
        <div className="slack-thread-state">
          <span className="slack-thread-error">{loadError}</span>
          <button className="ghost-button" type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : !thread ? (
        <p className="muted">Reading the thread from Slack…</p>
      ) : thread.readError ? (
        <ReadErrorState
          thread={thread}
          busy={busy}
          notice={notice}
          onRetry={() => void load()}
          onSweep={async () => {
            setBusy(true);
            try {
              const result = await invoke<RemoveReactionsResult>('remove_job_reactions', { jobId, names: null });
              setNotice(describeRemoval(result));
            } catch (err) {
              setNotice(String(err));
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : (
        <div>
          {loadError ? <p className="slack-thread-warning">{loadError}</p> : null}
          <div
            className="slack-thread-messages"
            ref={listRef}
            onScroll={e => {
              const list = e.currentTarget;
              pinnedToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
            }}
          >
            {thread.messages.map((message, index) => {
              const previous = thread.messages[index - 1];
              const grouped =
                previous !== undefined &&
                authorKey(previous) === authorKey(message) &&
                parseFloat(message.ts) - parseFloat(previous.ts) < GROUP_WINDOW_SECONDS;
              return (
                <MessageRow
                  key={message.ts}
                  message={message}
                  thread={thread}
                  grouped={grouped}
                  busy={busy}
                  editing={editing?.ts === message.ts ? editing.text : null}
                  confirmingDelete={confirmDelete === message.ts}
                  picker={pickerFor?.ts === message.ts ? pickerFor.anchor : null}
                  onReact={name => toggleReaction(message, name)}
                  onTogglePicker={anchor => togglePicker(message.ts, anchor)}
                  onClosePicker={() => setPickerFor(null)}
                  onStartEdit={() => {
                    setConfirmDelete(null);
                    setEditing({ ts: message.ts, text: fromSlackText(message.text ?? '') });
                  }}
                  onEditChange={text => setEditing({ ts: message.ts, text })}
                  onSaveEdit={() => void saveEdit()}
                  onCancelEdit={() => setEditing(null)}
                  onAskDelete={() => {
                    setEditing(null);
                    setConfirmDelete(message.ts);
                  }}
                  onConfirmDelete={async () => {
                    if (await act('delete_miniog_message', { ts: message.ts })) setConfirmDelete(null);
                  }}
                  onCancelDelete={() => setConfirmDelete(null)}
                />
              );
            })}
          </div>
          {actionError ? <p className="slack-thread-error slack-thread-action-error">{actionError}</p> : null}
          <SlackComposer
            busy={busy}
            participants={[...new Set(thread.messages.map(message => message.user ?? ''))].filter(Boolean)}
            onSend={sendMessage}
            onAsk={controls ? askMiniog : undefined}
            askBlocked={
              controls?.busyJobId
                ? 'miniOG is already working in this thread.'
                : controls?.starting
                  ? 'A run started from here is waiting to be picked up.'
                  : null
            }
          />
        </div>
      )}
    </SectionCard>
  );
}

type MessageRowProps = {
  message: SlackMessage;
  thread: RunThread;
  grouped: boolean;
  busy: boolean;
  editing: string | null;
  confirmingDelete: boolean;
  /** The button the picker is open from, when it's open on this message. */
  picker: HTMLElement | null;
  onReact: (name: string) => void;
  onTogglePicker: (anchor: HTMLElement) => void;
  onClosePicker: () => void;
  onStartEdit: () => void;
  onEditChange: (text: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
};

function MessageRow({
  message,
  thread,
  grouped,
  busy,
  editing,
  confirmingDelete,
  picker,
  onReact,
  onTogglePicker,
  onClosePicker,
  onStartEdit,
  onEditChange,
  onSaveEdit,
  onCancelEdit,
  onAskDelete,
  onConfirmDelete,
  onCancelDelete,
}: MessageRowProps) {
  const author = authorOf(message, thread.users);
  const time = messageTime(message.ts);
  const isMiniog = Boolean(thread.botUserId) && message.user === thread.botUserId;
  // A gate prompt's buttons live in its blocks, and an edit would strip them.
  const hasButtons = message.blocks?.some(block => block.type === 'actions') ?? false;
  const isTrigger = message.ts === thread.triggerTs;
  const showHeader = !grouped || isTrigger;

  return (
    <div
      className={['slack-message', showHeader ? '' : 'slack-message-grouped', isTrigger ? 'slack-message-trigger' : '']
        .filter(Boolean)
        .join(' ')}
      data-ts={message.ts}
    >
      <div className="slack-message-gutter">
        {showHeader ? (
          author.avatarUrl ? (
            <img className="slack-avatar" src={author.avatarUrl} alt="" />
          ) : (
            <span className="slack-avatar slack-avatar-fallback">{author.name.slice(0, 1).toUpperCase()}</span>
          )
        ) : (
          <time className="slack-gutter-time" title={time.full}>
            {time.short.replace(/^.*, /, '')}
          </time>
        )}
      </div>
      <div className="slack-message-body">
        {showHeader ? (
          <div className="slack-message-meta">
            <span className="slack-author">{author.name}</span>
            {author.isBot ? <span className="slack-app-badge">APP</span> : null}
            <time title={time.full}>{time.short}</time>
            {isTrigger ? <span className="slack-run-tag">started this run</span> : null}
          </div>
        ) : null}

        {editing !== null ? (
          <div className="slack-edit">
            <textarea
              aria-label="Edit message"
              autoFocus
              value={editing}
              onChange={e => onEditChange(e.target.value)}
              onKeyDown={e => submitOnEnter(e, onSaveEdit)}
            />
            <div className="slack-edit-actions">
              <button className="ghost-button" type="button" onClick={onCancelEdit}>
                Cancel
              </button>
              <button className="primary-button" type="button" disabled={busy || !editing.trim()} onClick={onSaveEdit}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <div className="slack-message-text">
            <SlackText text={message.text ?? ''} users={thread.users} />
            {message.edited ? <span className="slack-edited"> (edited)</span> : null}
          </div>
        )}

        {message.files && message.files.length > 0 ? (
          <div className="slack-files">
            {message.files.map(file =>
              isImage(file) ? (
                <SlackImage key={file.id} file={file} />
              ) : (
                <a
                  key={file.id}
                  className="slack-file"
                  href={file.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={file.mimetype}
                >
                  📎 {file.title || file.name || 'File'}
                </a>
              ),
            )}
          </div>
        ) : null}

        {message.reactions && message.reactions.length > 0 ? (
          <div className="slack-reactions">
            {message.reactions.map(reaction => {
              const mine = reaction.users.includes(thread.botUserId);
              const who = reaction.users.map(id => thread.users[id]?.name ?? id).join(', ');
              return (
                <button
                  key={reaction.name}
                  type="button"
                  className={mine ? 'slack-reaction slack-reaction-mine' : 'slack-reaction'}
                  title={`${who} reacted with :${reaction.name}:. Click to ${mine ? 'remove' : 'add'} miniOG's.`}
                  aria-label={`${mine ? 'Remove' : 'Add'} miniOG's :${reaction.name}:`}
                  disabled={busy}
                  onClick={() => onReact(reaction.name)}
                >
                  <span className="slack-reaction-emoji">{emojiChar(reaction.name) ?? `:${reaction.name}:`}</span>
                  <span className="slack-reaction-count">{reaction.count}</span>
                </button>
              );
            })}
            <button
              type="button"
              className="slack-reaction slack-reaction-add"
              aria-label="Add a reaction as miniOG"
              disabled={busy}
              onClick={e => onTogglePicker(e.currentTarget)}
            >
              ☺︎+
            </button>
          </div>
        ) : null}

        {confirmingDelete ? (
          <div className="slack-confirm">
            <span>Delete this message for everyone?</span>
            <button className="ghost-button" type="button" onClick={onCancelDelete}>
              Cancel
            </button>
            <button className="primary-button slack-danger" type="button" disabled={busy} onClick={onConfirmDelete}>
              Delete
            </button>
          </div>
        ) : null}
      </div>

      {editing === null ? (
        <div className="slack-message-actions">
          <button
            type="button"
            className="slack-action"
            title="React as miniOG"
            aria-label="React as miniOG"
            onClick={e => onTogglePicker(e.currentTarget)}
          >
            ☺︎
          </button>
          {isMiniog ? (
            <>
              {hasButtons ? null : (
                <button
                  type="button"
                  className="slack-action"
                  title="Edit"
                  aria-label="Edit message"
                  onClick={onStartEdit}
                >
                  ✎
                </button>
              )}
              <button
                type="button"
                className="slack-action"
                title="Delete"
                aria-label="Delete message"
                onClick={onAskDelete}
              >
                🗑
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {picker ? <EmojiPicker anchor={picker} onPick={onReact} onClose={onClosePicker} /> : null}
    </div>
  );
}

type ReadErrorStateProps = {
  thread: RunThread;
  busy: boolean;
  notice: string | null;
  onRetry: () => void;
  onSweep: () => void;
};

function ReadErrorState({ thread, busy, notice, onRetry, onSweep }: ReadErrorStateProps) {
  const error = thread.readError;
  const code = error?.code ?? 'unknown_error';
  if (error?.kind === 'deleted') {
    return <p className="muted">The message that started this thread was deleted, so there's nothing to show.</p>;
  }
  if (error?.kind === 'noAccess') {
    return (
      <div className="slack-thread-state">
        <span className="muted">Slack won't let the app read this thread ({code}).</span>
        {thread.triggerTs ? (
          <button className="ghost-button" type="button" disabled={busy} onClick={onSweep}>
            Remove miniOG's emojis from the run's message
          </button>
        ) : null}
        {notice ? <span className="muted">{notice}</span> : null}
      </div>
    );
  }
  const message =
    error?.kind === 'auth'
      ? `Slack rejected the bot token (${code}). Check it in Settings.`
      : `Slack couldn't read this thread (${code}).`;
  return (
    <div className="slack-thread-state">
      <span className="slack-thread-error">{message}</span>
      <button className="ghost-button" type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
