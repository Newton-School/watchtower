import { getAdminUserIds } from '../../access/control.js';
import { clipText } from '../../slack/replyParts.js';
import type { AppConfig, DossierRole } from '../../types/contracts.js';

/**
 * Who reads the end of a change run (issue #601).
 *
 * Final messages used to be the coder's full account: process ids, `--no-verify`
 * commits, node_modules repairs, sandbox errors, 250 to 500 words of it, posted
 * to marketing and ops requesters. The person who asked needs what changed, the
 * PR, and anything they must do; the engineering detail belongs in the PR.
 *
 * An engineer still gets the full account: owners, admins (the core-dev group),
 * and anyone whose dossier says they are a dev.
 */
export function requesterIsEngineer(params: { userId: string; config: AppConfig; role?: DossierRole }): boolean {
  // Owners are in the admin list. The id is the person the run is for, not
  // whoever queued it: an owner retriggering a PM's request writes for the PM.
  if (getAdminUserIds(params.config).includes(params.userId)) return true;
  return params.role === 'dev';
}

/**
 * The requester summary, kept readable: the coder may write bullets, and the
 * engineering sanitiser would drop every one of them. Only whitespace is
 * normalised and the length capped.
 */
export function sanitizeRequesterSummary(raw: string): string {
  const text = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .filter((line, index, lines) => line.trim() !== '' || (index > 0 && lines[index - 1].trim() !== ''))
    .join('\n')
    .trim();
  return clipText(text, 700);
}

/**
 * The reply posted when a change run ends.
 *
 * `summary` is the coder's engineering account; `requesterSummary` is the two or
 * three plain sentences it wrote for the person who asked. A non-engineer reads
 * the latter when there is one, with a pointer to the PR for the rest.
 */
export function composeChangeReply(params: {
  summary: string;
  requesterSummary: string;
  engineerReads: boolean;
  prUrl: string;
  /** Already formatted, with its leading blank lines; '' when there is none. */
  externalBlock: string;
  /** Set when a PR was expected and could not be opened: the plain summary must not read as shipped. */
  prFailed?: boolean;
  /** The change was added to this open PR rather than a new one (issue #730). */
  addedTo?: boolean;
}): string {
  const { summary, requesterSummary, engineerReads, prUrl, externalBlock, prFailed, addedTo } = params;
  const forRequester = !engineerReads && requesterSummary.trim() !== '';
  const text = forRequester ? requesterSummary.trim() : summary;
  const lead = addedTo && prUrl ? `Added to ${prUrl}: ${text}` : text;
  const prBlock = prUrl && !addedTo ? `\n${prUrl}` : '';
  const pointer =
    forRequester && prUrl && requesterSummary.trim() !== summary.trim()
      ? '\n_The engineering notes are in the PR._'
      : '';
  const noPr =
    forRequester && !prUrl && prFailed
      ? '\n:warning: I could not open a pull request for this, so nothing is live yet. An admin needs to look at the branch.'
      : '';
  return `${lead}${prBlock}${pointer}${noPr}${externalBlock}`.trim();
}
