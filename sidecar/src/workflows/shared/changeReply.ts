import { getAdminUserIds } from '../../access/control.js';
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
export function requesterIsEngineer(params: {
  userId: string;
  isOwnerAuthor: boolean;
  config: AppConfig;
  role?: DossierRole;
}): boolean {
  if (params.isOwnerAuthor) return true;
  if (getAdminUserIds(params.config).includes(params.userId)) return true;
  return params.role === 'dev';
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
}): string {
  const { summary, requesterSummary, engineerReads, prUrl, externalBlock } = params;
  const forRequester = !engineerReads && requesterSummary.trim() !== '';
  const lead = forRequester ? requesterSummary.trim() : summary;
  const prBlock = prUrl ? `\n${prUrl}` : '';
  const pointer =
    forRequester && prUrl && requesterSummary.trim() !== summary.trim()
      ? '\n_The engineering notes are in the PR._'
      : '';
  return `${lead}${prBlock}${pointer}${externalBlock}`.trim();
}
