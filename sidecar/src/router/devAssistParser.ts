export type DevAssistCommand =
  | { type: 'HELP' }
  | { type: 'STATUS' }
  | { type: 'RUNS'; limit: number }
  | { type: 'FAILURES'; limit: number }
  | { type: 'TRACE'; jobId: string; limit: number }
  | { type: 'DIAGNOSE'; jobId: string }
  | { type: 'LEARN' }
  | { type: 'HEAT'; limit: number }
  | { type: 'CANCEL'; jobId: string }
  | { type: 'MISSION_START'; goal: string }
  | { type: 'MISSION_SHOW' }
  | { type: 'MISSION_RUN_SWARM' }
  | { type: 'TRUST_SET'; target: 'channel' | 'user'; level: 'observe' | 'suggest' | 'execute' | 'merge' }
  | { type: 'REPLAY'; jobId: string }
  | { type: 'FORK'; jobId: string }
  | { type: 'SKILL_INSTALL'; name: string }
  | { type: 'SKILL_USE'; name: string }
  | { type: 'FEED_SET'; enabled: boolean }
  | { type: 'DIGEST_SET'; enabled: boolean; time?: string }
  | { type: 'POLICY_IMPORT'; pack: 'frontend' | 'backend' | 'release' }
  | { type: 'POLICY_SHOW' }
  | { type: 'POLICY_RELOAD' }
  | { type: 'INCIDENT_SET'; enabled: boolean }
  | { type: 'MY_QUEUE'; limit: number }
  | { type: 'WORKFLOW_LIST' }
  | { type: 'WORKFLOW_RELOAD' };

function stripMentions(text: string): string {
  return text
    .replace(/<@[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripPrefix(text: string): string | undefined {
  const cleaned = stripMentions(text);
  const normalized = cleaned
    .replace(/^([0-9]+[.)]\s+)+/i, '')
    .replace(/^([-*]\s+)+/i, '')
    .trim();
  const match = normalized.match(/^(wt|watchtower)\b\s*(.*)$/i);
  if (!match) {
    return undefined;
  }
  return match[2]?.trim() ?? '';
}

export function hasDevAssistPrefix(text: string): boolean {
  return stripPrefix(text) !== undefined;
}

function normalizeAliasBody(text: string): string {
  const cleaned = stripMentions(text);
  return cleaned
    .replace(/^([0-9]+[.)]\s+)+/i, '')
    .replace(/^([-*]\s+)+/i, '')
    .replace(/[!?.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseNaturalAliasCommand(text: string): DevAssistCommand | undefined {
  const normalized = normalizeAliasBody(text);
  if (!normalized || /^(wt|watchtower)\b/.test(normalized)) {
    return undefined;
  }

  if (/^(learn|learning|what did you learn|what have you learned|show learning)$/.test(normalized)) {
    return { type: 'LEARN' };
  }

  if (/^(status|health|health status|system status|watchtower status)$/.test(normalized)) {
    return { type: 'STATUS' };
  }

  if (/^(queue|my queue|show queue|what is in my queue|what's in my queue)$/.test(normalized)) {
    return { type: 'MY_QUEUE', limit: 5 };
  }

  if (/^(heat|hot channels|channel heat|show heat)$/.test(normalized)) {
    return { type: 'HEAT', limit: 5 };
  }

  if (/^(failures|failure|errors|error|recent failures|recent errors)$/.test(normalized)) {
    return { type: 'FAILURES', limit: 5 };
  }

  return undefined;
}

export function hasNaturalDevAssistAlias(text: string): boolean {
  return Boolean(parseNaturalAliasCommand(text));
}

export function parseDevAssistCommand(text: string): DevAssistCommand | undefined {
  const body = stripPrefix(text);
  if (body !== undefined) {
    return parsePrefixedDevAssistCommand(body);
  }

  return parseNaturalAliasCommand(text);
}

function parsePrefixedDevAssistCommand(body: string): DevAssistCommand | undefined {
  if (!body || /^help\b|^commands\b|^\?$/.test(body.toLowerCase())) {
    return { type: 'HELP' };
  }

  if (/^status\b/.test(body.toLowerCase())) {
    return { type: 'STATUS' };
  }

  const runsMatch = body.match(/^runs(?:\s+(\d+))?\b/i);
  if (runsMatch) {
    const rawLimit = Number(runsMatch[1] ?? '5');
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 20) : 5;
    return { type: 'RUNS', limit };
  }

  const failuresMatch = body.match(/^failures(?:\s+(\d+))?\b/i);
  if (failuresMatch) {
    const rawLimit = Number(failuresMatch[1] ?? '5');
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 20) : 5;
    return { type: 'FAILURES', limit };
  }

  const traceMatch = body.match(/^trace\s+([a-z0-9-]{6,})(?:\s+(\d+))?\b/i);
  if (traceMatch) {
    // Raised from 20/100: job_logs now carries a row per tool call, so a
    // 20-line tail would only show the last few seconds of a run instead of
    // the timeline the trace is for.
    const rawLimit = Number(traceMatch[2] ?? '60');
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 300) : 60;
    return {
      type: 'TRACE',
      jobId: traceMatch[1],
      limit,
    };
  }

  const diagnoseMatch = body.match(/^diagnose\s+([a-z0-9-]{6,})\b/i);
  if (diagnoseMatch) {
    return {
      type: 'DIAGNOSE',
      jobId: diagnoseMatch[1],
    };
  }

  const cancelMatch = body.match(/^cancel\s+([a-z0-9-]{6,})\b/i);
  if (cancelMatch) {
    return {
      type: 'CANCEL',
      jobId: cancelMatch[1],
    };
  }

  if (/^learn\b|^learning\b/.test(body.toLowerCase())) {
    return { type: 'LEARN' };
  }

  const heatMatch = body.match(/^heat(?:\s+(\d+))?\b/i);
  if (heatMatch) {
    const rawLimit = Number(heatMatch[1] ?? '5');
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 20) : 5;
    return { type: 'HEAT', limit };
  }

  const missionStartMatch = body.match(/^mission\s+start\s+(.+)$/i);
  if (missionStartMatch) {
    const goal = missionStartMatch[1]?.trim() ?? '';
    if (goal.length > 0) {
      return {
        type: 'MISSION_START',
        goal,
      };
    }
  }

  if (/^mission\s+show\b/i.test(body)) {
    return { type: 'MISSION_SHOW' };
  }

  if (/^mission\s+run\s+--swarm\b/i.test(body)) {
    return { type: 'MISSION_RUN_SWARM' };
  }

  const trustMatch = body.match(/^trust\s+(channel|user)\s+(observe|suggest|execute|merge)\b/i);
  if (trustMatch) {
    return {
      type: 'TRUST_SET',
      target: trustMatch[1].toLowerCase() as 'channel' | 'user',
      level: trustMatch[2].toLowerCase() as 'observe' | 'suggest' | 'execute' | 'merge',
    };
  }

  const replayMatch = body.match(/^replay\s+([a-z0-9-]{6,})\b/i);
  if (replayMatch) {
    return {
      type: 'REPLAY',
      jobId: replayMatch[1],
    };
  }

  const forkMatch = body.match(/^fork\s+([a-z0-9-]{6,})\b/i);
  if (forkMatch) {
    return {
      type: 'FORK',
      jobId: forkMatch[1],
    };
  }

  const skillInstallMatch = body.match(/^skill\s+install\s+([a-z0-9_.-]+)\b/i);
  if (skillInstallMatch) {
    return {
      type: 'SKILL_INSTALL',
      name: skillInstallMatch[1],
    };
  }

  const skillUseMatch = body.match(/^skill\s+use\s+([a-z0-9_.-]+)\b/i);
  if (skillUseMatch) {
    return {
      type: 'SKILL_USE',
      name: skillUseMatch[1],
    };
  }

  const feedMatch = body.match(/^feed\s+(on|off)\b/i);
  if (feedMatch) {
    return {
      type: 'FEED_SET',
      enabled: feedMatch[1].toLowerCase() === 'on',
    };
  }

  const digestOffMatch = body.match(/^digest\s+off\b/i);
  if (digestOffMatch) {
    return {
      type: 'DIGEST_SET',
      enabled: false,
    };
  }

  const digestOnMatch = body.match(/^digest\s+([0-2]?\d:[0-5]\d)\b/i);
  if (digestOnMatch) {
    return {
      type: 'DIGEST_SET',
      enabled: true,
      time: digestOnMatch[1],
    };
  }

  const policyImportMatch = body.match(/^policy\s+import\s+(frontend|backend|release)\b/i);
  if (policyImportMatch) {
    return {
      type: 'POLICY_IMPORT',
      pack: policyImportMatch[1].toLowerCase() as 'frontend' | 'backend' | 'release',
    };
  }

  if (/^policy\s+show\b/i.test(body)) {
    return { type: 'POLICY_SHOW' };
  }

  if (/^policy\s+reload\b/i.test(body)) {
    return { type: 'POLICY_RELOAD' };
  }

  const incidentMatch = body.match(/^incident\s+(on|off)\b/i);
  if (incidentMatch) {
    return {
      type: 'INCIDENT_SET',
      enabled: incidentMatch[1].toLowerCase() === 'on',
    };
  }

  if (/^workflow\s+list\b/i.test(body)) {
    return { type: 'WORKFLOW_LIST' };
  }

  if (/^workflow\s+reload\b/i.test(body)) {
    return { type: 'WORKFLOW_RELOAD' };
  }

  const myQueueMatch = body.match(/^my\s+queue(?:\s+(\d+))?\b/i);
  if (myQueueMatch) {
    const rawLimit = Number(myQueueMatch[1] ?? '5');
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 20) : 5;
    return {
      type: 'MY_QUEUE',
      limit,
    };
  }

  return undefined;
}

export function hasDevAssistCommand(text: string): boolean {
  return Boolean(parseDevAssistCommand(text));
}
