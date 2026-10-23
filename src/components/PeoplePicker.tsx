import { useId, useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { DirectoryPerson, SlackDirectory } from '../types';
import { wordsStartWith } from '../lib/slackText';
import { useEscapeLayer } from '../lib/escapeLayers';

const MAX_SUGGESTIONS = 8;
const SLACK_USER_ID = /^[UW][A-Z0-9]{6,}$/;

type Suggestion = { id: string; person: DirectoryPerson | null };

type PeoplePickerProps = {
  /** Slack user IDs, in the order they were added. */
  ids: string[];
  onChange: (ids: string[]) => void;
  /** The workspace's people; null while it loads or when it could not be read. */
  directory: SlackDirectory | null;
  label: string;
};

function displayName(person: DirectoryPerson): string {
  return person.realName ?? person.name;
}

/**
 * People listed by name, added by searching the Slack workspace. A Slack user
 * ID can be typed in when the person can't be found (or the workspace could
 * not be read).
 */
export function PeoplePicker({ ids, onChange, directory, label }: PeoplePickerProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const listId = useId();

  const byId = useMemo(() => new Map((directory?.people ?? []).map(person => [person.id, person])), [directory]);

  const suggestions = useMemo((): Suggestion[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const listed = new Set(ids);
    const found: Suggestion[] = (directory?.people ?? [])
      .filter(person => !listed.has(person.id))
      .filter(
        person => wordsStartWith(person.name, q) || wordsStartWith(person.realName, q) || person.id.toLowerCase() === q,
      )
      .sort((a, b) => displayName(a).localeCompare(displayName(b)))
      .slice(0, MAX_SUGGESTIONS)
      .map(person => ({ id: person.id, person }));
    const typedId = query.trim().toUpperCase();
    if (found.length === 0 && SLACK_USER_ID.test(typedId) && !listed.has(typedId)) {
      return [{ id: typedId, person: null }];
    }
    return found;
  }, [query, directory, ids]);

  const add = (id: string) => {
    onChange([...ids, id]);
    setQuery('');
    setHighlight(0);
  };

  const suggesting = suggestions.length > 0;
  useEscapeLayer(suggesting, () => setQuery(''));

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // The Settings page is one form; Enter here must not save it.
      e.preventDefault();
      const picked = suggestions[highlight];
      if (picked) add(picked.id);
    } else if (e.key === 'ArrowDown' && suggesting) {
      e.preventDefault();
      setHighlight(current => (current + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && suggesting) {
      e.preventDefault();
      setHighlight(current => (current - 1 + suggestions.length) % suggestions.length);
    }
  };

  return (
    <div className="people-picker">
      <span className="people-picker-label">
        {label} <span className="muted">{ids.length}</span>
      </span>
      {ids.length > 0 ? (
        <ul className="people-chips" aria-label={label}>
          {ids.map(id => {
            const person = byId.get(id);
            const name = person ? displayName(person) : id;
            return (
              <li
                key={id}
                className={person || !directory ? 'people-chip' : 'people-chip people-chip-unknown'}
                title={person ? id : directory ? `${id} is not in the Slack workspace` : id}
              >
                {person?.avatarUrl ? (
                  <img className="people-chip-avatar" src={person.avatarUrl} alt="" />
                ) : (
                  <span className="people-chip-avatar slack-avatar-fallback" aria-hidden="true">
                    {name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span>{name}</span>
                <button
                  type="button"
                  className="people-chip-remove"
                  aria-label={`Remove ${name}`}
                  onClick={() => onChange(ids.filter(other => other !== id))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="field-hint">Nobody yet.</p>
      )}
      <div className="people-picker-add">
        <input
          type="text"
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setQuery('')}
          placeholder={directory ? 'Add a person…' : 'Add a person by Slack user ID…'}
          aria-label={`Add a person to ${label}`}
          role="combobox"
          aria-expanded={suggesting}
          aria-controls={listId}
          aria-autocomplete="list"
        />
        {suggesting ? (
          <ul id={listId} className="slack-mention-list people-picker-list" role="listbox" aria-label="People">
            {suggestions.map((suggestion, index) => (
              <li key={suggestion.id} role="option" aria-selected={index === highlight}>
                <button
                  type="button"
                  className={index === highlight ? 'slack-mention-option slack-mention-active' : 'slack-mention-option'}
                  onMouseDown={e => e.preventDefault()}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => add(suggestion.id)}
                >
                  {suggestion.person?.avatarUrl ? (
                    <img className="slack-mention-avatar" src={suggestion.person.avatarUrl} alt="" />
                  ) : (
                    <span className="slack-mention-avatar slack-avatar-fallback" aria-hidden="true">
                      {suggestion.person ? displayName(suggestion.person).slice(0, 1).toUpperCase() : '+'}
                    </span>
                  )}
                  <span className="slack-mention-name">
                    {suggestion.person ? displayName(suggestion.person) : `Add ${suggestion.id}`}
                  </span>
                  {suggestion.person &&
                  suggestion.person.realName &&
                  suggestion.person.name !== suggestion.person.realName ? (
                    <span className="muted">{suggestion.person.name}</span>
                  ) : null}
                  {!suggestion.person && directory ? <span className="muted">not in the workspace</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
