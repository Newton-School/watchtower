import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, DragEvent as ReactDragEvent } from 'react';
import type { SlackDirectory } from '../types';
import { loadSlackDirectory } from '../lib/slackCache';
import { toSlackText } from '../lib/slackText';
import { EmojiPicker } from './EmojiPicker';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_SUGGESTIONS = 8;

/** What the box shows for a mention, and the Slack markup it posts as. */
type Mention = { label: string; token: string };

type Suggestion = { key: string; label: string; detail: string | null; avatarUrl: string | null; token: string };

type Attachment = { id: number; file: File; previewUrl: string | null };

export type ComposedMessage = { text: string; broadcast: boolean; files: File[] };

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

function wordsStartWith(text: string | null, query: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.startsWith(query) || lower.split(/[\s._-]+/).some(word => word.startsWith(query));
}

type SlackComposerProps = {
  busy: boolean;
  /** People in the thread, suggested first. */
  participants: string[];
  onSend: (message: ComposedMessage) => Promise<boolean>;
};

/** The reply box: posts as miniOG, with @mentions, attachments, emoji and "also send to channel". */
export function SlackComposer({ busy, participants, onSend }: SlackComposerProps) {
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
      .filter(person => !q || wordsStartWith(person.name, q) || wordsStartWith(person.realName, q))
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

  const send = async () => {
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

  return (
    <form
      className={dragging ? 'slack-composer slack-composer-dragging' : 'slack-composer'}
      onSubmit={e => {
        e.preventDefault();
        void send();
      }}
      onDragEnter={(e: ReactDragEvent) => {
        if (e.dataTransfer.types.includes('Files')) {
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

      {attachments.length > 0 ? (
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
        aria-label="Reply as miniOG"
        placeholder="Reply as miniOG…"
        rows={2}
        value={draft}
        onChange={e => {
          setDraft(e.target.value);
          findMentionQuery(e.target.value, e.target.selectionStart);
        }}
        onSelect={e => findMentionQuery(e.currentTarget.value, e.currentTarget.selectionStart)}
        onPaste={(e: ReactClipboardEvent<HTMLTextAreaElement>) => {
          if (e.clipboardData.files.length > 0) {
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
            if (e.key === 'Escape') {
              e.preventDefault();
              setMentionQuery(null);
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
            title="Attach files"
            aria-label="Attach files"
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
        </div>
        <span className="muted slack-composer-hint">Posts as miniOG. Shift+Enter for a new line.</span>
        <button className="primary-button" type="submit" disabled={busy || (!draft.trim() && attachments.length === 0)}>
          Send
        </button>
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
