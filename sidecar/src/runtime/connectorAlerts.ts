import type { JobStore } from '../state/jobStore.js';

/**
 * Telling the owner when a connector needs signing in again (issue #593).
 *
 * A connector signed in with OAuth for the headless CLI lapses without notice.
 * On 13 Oct fifteen runs found Metabase at `needs-auth`. On 18 Oct a data
 * question ran no query, and its reply told the requester to sign in from
 * `/mcp`, which only the owner can do: they were blocked until the owner
 * happened to notice. Every run reports its connectors' state when it starts.
 * The first run to find one needing sign-in, or failing to connect, tells the
 * owner, once, until a later run finds it connected again.
 */

export interface ConnectorStatus {
  name: string;
  status: string;
}

type StateStore = Pick<JobStore, 'getState' | 'setState'>;
type Listener = (statuses: ConnectorStatus[], jobId?: string) => void;

const stateKey = (name: string): string => `connector_alert:${name}`;

/** The connectors to tell the owner about now. Records them, so each lapse is told once. */
export function connectorsToAlert(statuses: ConnectorStatus[], store: StateStore): ConnectorStatus[] {
  const alert: ConnectorStatus[] = [];
  for (const connector of statuses) {
    const key = stateKey(connector.name);
    if (connector.status === 'connected') {
      if (store.getState(key)) store.setState(key, '');
    } else if ((connector.status === 'needs-auth' || connector.status === 'failed') && !store.getState(key)) {
      store.setState(key, new Date().toISOString());
      alert.push(connector);
    }
  }
  return alert;
}

/** What the owner is told about a connector runs cannot reach. */
export function connectorAlertText(connector: ConnectorStatus, jobId?: string): string {
  const { name, status } = connector;
  return [
    status === 'needs-auth' ? `\`${name}\` needs signing in again:` : `\`${name}\` failed to connect:`,
    'runs given it cannot reach it, so questions that need it go unanswered.',
    `${status === 'needs-auth' ? 'Sign in' : 'Check it'} from Claude Code on this machine: \`/mcp\`, then \`${name}\`.`,
    ...(jobId ? [`First seen in job \`${jobId.slice(0, 8)}\`.`] : []),
  ].join(' ');
}

let listener: Listener | undefined;

/** Where runs report their connectors' state. Set once at startup. */
export function onConnectorStatuses(fn: Listener | undefined): void {
  listener = fn;
}

/** Called by a run once it knows its connectors' state. Never throws into the run. */
export function reportConnectorStatuses(statuses: ConnectorStatus[], jobId?: string): void {
  try {
    listener?.(statuses, jobId);
  } catch {
    // Telling the owner must not affect the run.
  }
}
