import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from 'react';
import type { AnswerKind, SlackDirectory } from '../types';
import { loadSlackDirectory } from '../lib/slackCache';
import { toSlackText, wordsStartWith } from '../lib/slackText';
import { readFlag, writeFlag } from '../lib/prefs';
import { useEscapeLayer } from '../lib/escapeLayers';
import { EmojiPicker } from './EmojiPicker';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_SUGGESTIONS = 8;
const ASK_POSTS_KEY = 'watchtower.askPostsInThread';
const ANSWER_POSTS_KEY = 'watchtower.answerPostsInThread';

const ANSWER_PLACEHOLDERS: Record<AnswerKind, string> = {
  approval: 'Answer miniOG: yes to go ahead, no, or what to change…',
  question: "Answer miniOG's question…",
  repo_choice: 'Tell miniOG which repo…',
  confirm: 'Type the phrase miniOG asked for…',
  paused: 'Answer miniOG to pick this up again…',
};

function answerPlaceholder(answering: ComposerAnswering | null): string {
  if (!answering) return 'Answer miniOG…';
  if (answering.kind === 'confirm' && answering.expects) return `Type "${answering.expects}" to confirm…`;
  return ANSWER_PLACEHOLDERS[answering.kind];
}

/** What the box shows for a mention, and the Slack markup it posts as. */
type Mention = { label: string; token: string };

type Suggestion = { key: string; label: string; detail: string | null; avatarUrl: string | null; token: string };

type Attachment = { id: number; file: File; previewUrl: string | null };

export type ComposedMessage = { text: string; broadcast: boolean; files: File[] };

/** An ask that starts a new run here, or an answer to a run waiting here, on the owner's authority. */
export type ComposedAsk = { text: string; postAsk: boolean };

/** miniOG waits for an answer in the thread: which run, on which question. */
export type ComposerAnswering = {
  kind: AnswerKind;
  jobId: string;
  promptTs: string | null;
  expects: string | null;
  blocked: string | null;
};

/** An answer, with the question it was written for. */
export type ComposedAnswer = ComposedAsk & { jobId: string; promptTs: string | null };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Swap each mention's label for its Slack markup in one pass, longest label
 * first, so "@Sam K" wins over "@Sam", "@Sam" never matches inside a
 * hand-typed "@Samantha", and one swap can't land inside another's markup.
 */
export function applyMentions(slackText: string, mentions: Mention[]): string {
  if (mentions.length === 0) return slackText;
  const tokens = new Map(mentions.map(mention => [toSlackText(mention.label), mention.token]));
  const labels = [...tokens.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  // Not followed by more of a name: "@core" stays out of "@core-dev" and "@dipesh.rajoria".
  return slackText.replace(new RegExp(`(?:${labels.join('|')})(?![.-]*\\w)`, 'g'), label => tokens.get(label) ?? label);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type SlackComposerProps = {
  busy: boolean;
  /** People in the thread, suggested first. */
  participants: string[];
  onSend: (message: ComposedMessage) => Promise<boolean>;
  /** Offers the "Ask miniOG" mode, which starts a run here. */
  onAsk?: (ask: ComposedAsk) => Promise<boolean>;
  /** Why an ask can't start right now. */
  askBlocked?: string | null;
  /** miniOG waits for an answer here: "Answer miniOG" takes the place of "Ask miniOG". */
  answering?: ComposerAnswering | null;
  onAnswer?: (answer: ComposedAnswer) => Promise<boolean>;
};

/**
 * The reply box: posts as miniOG, with @mentions, attachments, emoji and
 * "also send to channel". In "Ask miniOG" mode it starts a new run in the
 * thread instead, with the ask posted first or not at all. While miniOG waits
 * for an answer in the thread, that mode is "Answer miniOG", which answers it.
 */
export function SlackComposer({
  busy,
  participants,
  onSend,
  onAsk,
  askBlocked = null,
  answering = null,
  onAnswer,
}: SlackComposerProps) {
  const [mode, setMode] = useState<'reply' | 'ask' | 'answer'>('reply');
  const [postAsk, setPostAsk] = useState(() => readFlag(ASK_POSTS_KEY, true));
  const [postAnswer, setPostAnswer] = useState(() => readFlag(ANSWER_POSTS_KEY, true));
  // The question an answer is being written to, from when Answer was picked.
  const [answerFor, setAnswerFor] = useState<{ jobId: string; promptTs: string | null } | null>(null);
  const [draft, setDraft] = useState('');
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [broadcast, setBroadcast] = useState(false);
  const [directory, setDirectory] = useState<SlackDirectory | null>(null);
  // The @word being typed: where it starts and what follows the @.
  const [mentionQuery, setMentionQuery] = useState<{ start: number; text: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave also fire over child elements, so count them.
  const dragDepth = useRef(0);
  // Reading files takes a moment before the parent marks itself busy; this
  // stops a second Enter from sending the same files twice.
  const sending = useRef(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextAttachmentId = useRef(0);
  const attachmentsRef = useRef<Attachment[]>([]);
  attachmentsRef.current = attachments;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // The second mode answers miniOG while it waits, and asks it for a new run otherwise.
  const second = answering && onAnswer ? 'answer' : onAsk ? 'ask' : null;
  // miniOG moved on to another question since Answer was picked.
  const askedAnew =
    mode === 'answer' &&
    second === 'answer' &&
    (answerFor?.jobId !== answering?.jobId || answerFor?.promptTs !== answering?.promptTs);
  // The thread changed under a draft meant for miniOG: an ask must not go as
  // an answer, an answer as a new ask, nor an answer to a question not read,
  // so nothing goes until a mode is picked again.
  const stale = (mode !== 'reply' && mode !== second) || askedAnew;
  const toMiniog = mode !== 'reply';
  const asking = mode === 'ask' && !stale;
  const answeringNow = mode === 'answer' && !stale;
  const posting = mode === 'answer' ? postAnswer : postAsk;
  const blockedNote = askedAnew
    ? 'miniOG asked something new. Read it, then pick Answer miniOG again.'
    : stale
      ? mode === 'answer'
        ? "miniOG isn't waiting for an answer anymore, so this can't go as one."
        : second === 'answer'
          ? 'miniOG is waiting for an answer now. Pick Answer miniOG to send this as the answer.'
          : "miniOG can't take an ask here right now."
      : asking
        ? askBlocked
        : answeringNow
          ? (answering?.blocked ?? null)
          : null;
  const noteId = useId();

  const pickMode = (next: 'reply' | 'ask' | 'answer') => {
    setMode(next);
    setAnswerFor(next === 'answer' && answering ? { jobId: answering.jobId, promptTs: answering.promptTs } : null);
    setFileError(null);
  };

  // Read the directory early; the first read takes a few seconds. If it
  // failed, typing @ tries again.
  const wantsDirectory = mentionQuery !== null && directory === null;
  const directoryRequested = useRef(false);
  useEffect(() => {
    if (directoryRequested.current && !wantsDirectory) return;
    directoryRequested.current = true;
    loadSlackDirectory()
      .then(setDirectory)
      .catch(() => setDirectory(null));
  }, [wantsDirectory]);

  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
    },
    [],
  );

  const suggestions = useMemo((): Suggestion[] => {
    if (!mentionQuery || !directory) return [];
    const q = mentionQuery.text.toLowerCase();
    const inThread = new Set(participants);
    const people = directory.people
      .filter(
        person =>
          !q ||
          wordsStartWith(person.name, q) ||
          wordsStartWith(person.realName, q) ||
          wordsStartWith(person.username, q),
      )
      .sort((a, b) => Number(inThread.has(b.id)) - Number(inThread.has(a.id)) || a.name.localeCompare(b.name))
      .map(person => ({
        key: person.id,
        label: person.name,
        detail: person.realName && person.realName !== person.name ? person.realName : null,
        avatarUrl: person.avatarUrl,
        token: `<@${person.id}>`,
      }));
    const groups = q
      ? directory.groups
          .filter(group => wordsStartWith(group.handle, q) || wordsStartWith(group.name, q))
          .map(group => ({
            key: group.id,
            label: group.handle,
            detail: group.name,
            avatarUrl: null,
            token: `<!subteam^${group.id}|@${group.handle}>`,
          }))
      : [];
    return [...people, ...groups].slice(0, MAX_SUGGESTIONS);
  }, [mentionQuery, directory, participants]);

  const findMentionQuery = (text: string, caret: number) => {
    const match = /(^|\s)@([^\s@]{0,30})$/.exec(text.slice(0, caret));
    setMentionQuery(match ? { start: caret - match[2].length - 1, text: match[2] } : null);
    setHighlight(0);
  };

  const insertAtCaret = (insert: string, replaceFrom?: number) => {
    const box = boxRef.current;
    const caret = box?.selectionStart ?? draft.length;
    const from = replaceFrom ?? caret;
    const next = draft.slice(0, from) + insert + draft.slice(caret);
    setDraft(next);
    const at = from + insert.length;
    requestAnimationFrame(() => {
      box?.focus();
      box?.setSelectionRange(at, at);
    });
  };

  const pickSuggestion = (suggestion: Suggestion) => {
    if (!mentionQuery) return;
    const label = `@${suggestion.label}`;
    insertAtCaret(`${label} `, mentionQuery.start);
    setMentions(current => [...current.filter(m => m.label !== label), { label, token: suggestion.token }]);
    setMentionQuery(null);
  };

  const addFiles = (files: FileList | File[]) => {
    if (toMiniog) {
      setFileError('Files go with a reply. Switch to Reply to attach them.');
      return;
    }
    const added: Attachment[] = [];
    let refusal: string | null = null;
    let count = attachments.length;
    let total = attachments.reduce((sum, attachment) => sum + attachment.file.size, 0);
    for (const file of Array.from(files)) {
      if (file.size === 0) {
        refusal = `${file.name} is empty, so it can't be attached.`;
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        refusal = `${file.name} is over 20 MB, so it can't be attached.`;
        continue;
      }
      if (count + 1 > MAX_FILES || total + file.size > MAX_TOTAL_BYTES) {
        refusal = `Up to ${MAX_FILES} files and 50 MB go in one reply.`;
        break;
      }
      count += 1;
      total += file.size;
      added.push({
        id: nextAttachmentId.current++,
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      });
    }
    setFileError(refusal);
    if (added.length > 0) setAttachments(current => [...current, ...added]);
  };

  const removeAttachment = (id: number) => {
    setAttachments(current => {
      const gone = current.find(attachment => attachment.id === id);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return current.filter(attachment => attachment.id !== id);
    });
  };

  const sendToMiniog = async () => {
    const typed = draft;
    if (busy || sending.current || blockedNote || !typed.trim()) return;
    const text = applyMentions(toSlackText(typed.trim()), mentions);
    let send: (() => Promise<boolean>) | null = null;
    if (answeringNow && onAnswer && answerFor) {
      send = () => onAnswer({ text, postAsk: posting, ...answerFor });
    } else if (asking && onAsk) {
      send = () => onAsk({ text, postAsk: posting });
    }
    if (!send) return;
    sending.current = true;
    try {
      if (!(await send())) return;
      // Anything typed while it went stays, in this mode, so it can't go out as a reply.
      if (draftRef.current !== typed) return;
      setDraft('');
      setMentions([]);
      // Back to replying, so the next Enter sends miniOG nothing more.
      pickMode('reply');
    } finally {
      sending.current = false;
    }
  };

  const send = async () => {
    if (toMiniog) {
      await sendToMiniog();
      return;
    }
    const typed = draft;
    const sentAttachments = attachments;
    if (busy || sending.current || (!typed.trim() && sentAttachments.length === 0)) return;
    sending.current = true;
    try {
      const sent = await onSend({
        text: applyMentions(toSlackText(typed.trim()), mentions),
        broadcast: broadcast && sentAttachments.length === 0,
        files: sentAttachments.map(attachment => attachment.file),
      });
      if (!sent) return;
      // Keep anything typed or attached while the send was in flight.
      if (draftRef.current === typed) {
        setDraft('');
        setMentions([]);
      }
      const sentIds = new Set(sentAttachments.map(attachment => attachment.id));
      for (const attachment of sentAttachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      setAttachments(current => current.filter(attachment => !sentIds.has(attachment.id)));
      setBroadcast(false);
    } finally {
      sending.current = false;
    }
  };

  const suggesting = suggestions.length > 0;
  // Escape closes the suggestions before anything opened earlier.
  useEscapeLayer(suggesting, () => setMentionQuery(null));

  return (
    <form
      className={dragging ? 'slack-composer slack-composer-dragging' : 'slack-composer'}
      onSubmit={e => {
        e.preventDefault();
        void send();
      }}
      onDragEnter={(e: ReactDragEvent) => {
        if (!toMiniog && e.dataTransfer.types.includes('Files')) {
          dragDepth.current += 1;
          setDragging(true);
        }
      }}
      onDragOver={(e: ReactDragEvent) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e: ReactDragEvent) => {
        if (e.dataTransfer.files.length > 0) {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }
        dragDepth.current = 0;
        setDragging(false);
      }}
    >
      {second || mode !== 'reply' ? (
        <div
          className="slack-composer-modes"
          role="group"
          aria-label={second === 'answer' ? 'Reply or answer' : 'Reply or ask'}
        >
          <button
            type="button"
            aria-pressed={mode === 'reply'}
            className={mode === 'reply' ? 'slack-composer-mode slack-composer-mode-active' : 'slack-composer-mode'}
            onClick={() => pickMode('reply')}
          >
            Reply as miniOG
          </button>
          {second ? (
            <button
              type="button"
              aria-pressed={mode === second && !stale}
              className={
                mode === second && !stale ? 'slack-composer-mode slack-composer-mode-active' : 'slack-composer-mode'
              }
              onClick={() => pickMode(second)}
            >
              {second === 'answer' ? 'Answer miniOG' : 'Ask miniOG'}
            </button>
          ) : null}
        </div>
      ) : null}

      {suggesting ? (
        <ul className="slack-mention-list" role="listbox" aria-label="People to mention">
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.key} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                className={index === highlight ? 'slack-mention-option slack-mention-active' : 'slack-mention-option'}
                onMouseDown={e => e.preventDefault()}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => pickSuggestion(suggestion)}
              >
                {suggestion.avatarUrl ? (
                  <img className="slack-mention-avatar" src={suggestion.avatarUrl} alt="" />
                ) : (
                  <span className="slack-mention-avatar slack-avatar-fallback">@</span>
                )}
                <span className="slack-mention-name">{suggestion.label}</span>
                {suggestion.detail ? <span className="muted">{suggestion.detail}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {attachments.length > 0 && !toMiniog ? (
        <div className="slack-attachments">
          {attachments.map(attachment => (
            <div className="slack-attachment" key={attachment.id}>
              {attachment.previewUrl ? <img src={attachment.previewUrl} alt="" /> : <span>📄</span>}
              <span className="slack-attachment-name">{attachment.file.name}</span>
              <span className="muted">{formatBytes(attachment.file.size)}</span>
              <button
                type="button"
                className="slack-action"
                aria-label={`Remove ${attachment.file.name}`}
                onClick={() => removeAttachment(attachment.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <textarea
        ref={boxRef}
        aria-label={mode === 'answer' ? 'Answer miniOG' : mode === 'ask' ? 'Ask miniOG' : 'Reply as miniOG'}
        aria-describedby={blockedNote ? noteId : undefined}
        placeholder={
          mode === 'answer'
            ? answerPlaceholder(answering)
            : mode === 'ask'
              ? 'Ask miniOG to do something in this thread…'
              : 'Reply as miniOG…'
        }
        rows={2}
        value={draft}
        onChange={e => {
          setDraft(e.target.value);
          findMentionQuery(e.target.value, e.target.selectionStart);
        }}
        onSelect={e => findMentionQuery(e.currentTarget.value, e.currentTarget.selectionStart)}
        onPaste={(e: ReactClipboardEvent<HTMLTextAreaElement>) => {
          // An ask takes no files, so a paste is just its text (copied cells
          // carry an image of themselves too).
          if (!toMiniog && e.clipboardData.files.length > 0) {
            e.preventDefault();
            addFiles(e.clipboardData.files);
          }
        }}
        onKeyDown={e => {
          if (suggesting) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setHighlight(current => (current + step + suggestions.length) % suggestions.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              pickSuggestion(suggestions[highlight]);
              return;
            }
          }
          // WebKit ends an IME composition before the Enter keydown; keyCode 229 still marks it.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            void send();
          }
        }}
      />

      <div className="slack-composer-footer">
        <div className="slack-composer-tools">
          <button
            type="button"
            className="slack-action"
            title={toMiniog ? 'Files go with a reply' : 'Attach files'}
            aria-label="Attach files"
            disabled={toMiniog}
            onClick={() => fileRef.current?.click()}
          >
            📎
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            aria-label="Files to attach"
            onChange={e => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="slack-action"
            title="Insert emoji"
            aria-label="Insert emoji"
            onClick={e => {
              const button = e.currentTarget;
              setEmojiAnchor(current => (current === button ? null : button));
            }}
          >
            ☺︎
          </button>
          {toMiniog ? (
            <label className="slack-broadcast">
              <input
                type="checkbox"
                checked={posting}
                onChange={e => {
                  if (mode === 'answer') {
                    setPostAnswer(e.target.checked);
                    writeFlag(ANSWER_POSTS_KEY, e.target.checked);
                  } else {
                    setPostAsk(e.target.checked);
                    writeFlag(ASK_POSTS_KEY, e.target.checked);
                  }
                }}
              />
              {mode === 'answer' ? 'Post the answer in the thread' : 'Post the ask in the thread'}
            </label>
          ) : (
            <label
              className="slack-broadcast"
              title={attachments.length > 0 ? "Slack can't send files to the channel from a thread reply." : undefined}
            >
              <input
                type="checkbox"
                checked={broadcast && attachments.length === 0}
                disabled={attachments.length > 0}
                onChange={e => setBroadcast(e.target.checked)}
              />
              Also send to channel
            </label>
          )}
        </div>
        <span className="muted slack-composer-hint">
          {!toMiniog
            ? second === 'answer' && !answering?.blocked
              ? 'Posts as miniOG. To answer its question, use Answer miniOG.'
              : 'Posts as miniOG. Shift+Enter for a new line.'
            : mode === 'answer'
              ? postAnswer
                ? 'miniOG posts your answer here, then carries on with it.'
                : 'Nothing is posted; miniOG just carries on with your answer.'
              : postAsk
                ? 'miniOG posts the ask here first, then works on it.'
                : 'Nothing is posted, not even an emoji; miniOG just starts answering here.'}
        </span>
        {toMiniog ? (
          <button
            className="primary-button"
            type="submit"
            disabled={busy || Boolean(blockedNote) || !draft.trim()}
            title={blockedNote ?? undefined}
          >
            {mode === 'answer' ? 'Answer' : 'Ask'}
          </button>
        ) : (
          <button
            className="primary-button"
            type="submit"
            disabled={busy || (!draft.trim() && attachments.length === 0)}
          >
            Send
          </button>
        )}
      </div>
      {/* Always there, so a screen reader announces the note when it appears. */}
      <div className={blockedNote ? 'slack-thread-warning slack-composer-note' : undefined} id={noteId} role="status">
        {blockedNote}
      </div>
      {fileError ? <p className="slack-thread-error">{fileError}</p> : null}
      {emojiAnchor ? (
        <EmojiPicker
          anchor={emojiAnchor}
          onPick={name => {
            insertAtCaret(`:${name}: `);
            setEmojiAnchor(null);
          }}
          onClose={() => setEmojiAnchor(null)}
        />
      ) : null}
    </form>
  );
}
