import './stdioBootstrap.js';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConversationStore, type ConversationThreadRow } from '../state/conversationStore.js';
import { createExportLog } from '../egress/exportLog.js';

/**
 * Local stdio MCP server over the conversation store (M5). Read-only by
 * construction: the DB is opened with `readonly: true` and this entrypoint
 * never imports the sidecar runtime — it can run while the sidecar runs
 * (WAL-safe cross-process).
 *
 * Register for Claude Code:
 *   claude mcp add -s user watchtower-conversations -- node <repo>/sidecar/dist/mcp/stdioMcpServer.js
 */

const DEFAULT_PROD_DB = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'com.dipesh.watchtower',
  'watchtower.db',
);

function openDb(): Database.Database {
  const dbPath = process.env.WATCHTOWER_DB_PATH ?? DEFAULT_PROD_DB;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const hasTables = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'conversation_threads'`).get();
  if (!hasTables) {
    db.close();
    throw new Error(
      `${dbPath} has no conversation tables yet — run the Watchtower sidecar once (it migrates on boot), or point WATCHTOWER_DB_PATH at the right database.`,
    );
  }
  return db;
}

function threadSummary(thread: ConversationThreadRow, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    channelId: thread.channelId,
    threadTs: thread.threadTs,
    channel: thread.channelName ? `#${thread.channelName}` : thread.channelId,
    title: thread.title ?? null,
    summary: thread.summary ?? null,
    decisions: thread.decisions,
    actionItems: thread.actionItems,
    participants: thread.participants.filter(p => !p.isBot).map(p => p.displayName ?? p.userId),
    messageCount: thread.messageCount,
    lastActivity: thread.lastActivityTs ? new Date(Number(thread.lastActivityTs) * 1000).toISOString() : null,
    visibility: thread.visibility,
    ...extra,
  };
}

const TOOLS = [
  {
    name: 'search_conversations',
    description:
      'Full-text search over captured miniOG Slack conversations (messages, titles, summaries). Returns matching threads with their synthesis and matching snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search query' },
        limit: { type: 'number', description: 'Max threads to return (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_thread',
    description: 'Fetch one captured thread: synthesis (title/summary/decisions) and optionally the transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Slack channel id (C…)' },
        threadTs: { type: 'string', description: 'Thread root ts, e.g. 1787270000.000100' },
        includeTranscript: { type: 'boolean', description: 'Include the message transcript (default true)' },
      },
      required: ['channelId', 'threadTs'],
    },
  },
  {
    name: 'list_recent_threads',
    description: 'List the most recently active captured conversations, newest first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max threads (default 20)' } },
    },
  },
  {
    name: 'get_decisions',
    description:
      'Every decision extracted from captured conversations, newest first, each with its source thread. Optional substring filter.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Case-insensitive substring filter on the decision text' },
        limit: { type: 'number', description: 'Max decisions (default 50)' },
      },
    },
  },
] as const;

async function main(): Promise<void> {
  const db = openDb();
  const conversations = createConversationStore(db);
  const exportLog = createExportLog(db);

  const githubUrlFor = (channelId: string, threadTs: string): string | undefined => {
    try {
      const record = exportLog.get('github', channelId, threadTs);
      return record?.commitSha ? record.targetUrl : undefined;
    } catch {
      return undefined;
    }
  };

  const server = new Server({ name: 'watchtower-conversations', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS] }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const asText = (value: unknown): { content: Array<{ type: 'text'; text: string }> } => ({
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    });

    try {
      switch (request.params.name) {
        case 'search_conversations': {
          const query = String(args.query ?? '');
          const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
          const hits = conversations.searchMessages(query, { limit, includePrivate: true });
          return asText(
            hits.map(hit =>
              threadSummary(hit.thread, {
                score: Math.round(hit.score * 1000) / 1000,
                snippets: hit.snippets.map(s => ({
                  speaker: s.isBot ? 'miniOG' : (s.displayName ?? s.userId),
                  text: s.snippet,
                })),
                knowledgeBaseUrl: githubUrlFor(hit.thread.channelId, hit.thread.threadTs) ?? null,
              }),
            ),
          );
        }
        case 'get_thread': {
          const channelId = String(args.channelId ?? '');
          const threadTs = String(args.threadTs ?? '');
          const thread = conversations.getThread(channelId, threadTs);
          if (!thread || thread.status === 'forgotten') {
            return asText({ error: 'thread not captured (or forgotten)' });
          }
          const includeTranscript = args.includeTranscript !== false;
          const transcript = includeTranscript
            ? conversations
                .getMessages(thread.id, { limit: 500, order: 'desc' })
                .reverse()
                .map(m => ({
                  ts: m.messageTs,
                  speaker: m.isBot ? 'miniOG' : (m.displayName ?? m.userId),
                  text: m.text,
                }))
            : undefined;
          return asText(
            threadSummary(thread, {
              knowledgeBaseUrl: githubUrlFor(channelId, threadTs) ?? null,
              ...(transcript ? { transcript } : {}),
            }),
          );
        }
        case 'list_recent_threads': {
          const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
          return asText(conversations.listRecentThreads({ limit }).map(t => threadSummary(t)));
        }
        case 'get_decisions': {
          const topic = typeof args.topic === 'string' ? args.topic.toLowerCase() : undefined;
          const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
          const decisions: Array<Record<string, unknown>> = [];
          for (const thread of conversations.listThreadsWithDecisions({ limit: 500 })) {
            for (const decision of thread.decisions) {
              if (topic && !decision.toLowerCase().includes(topic)) continue;
              decisions.push({
                decision,
                thread: thread.title ?? 'Slack thread',
                channel: thread.channelName ? `#${thread.channelName}` : thread.channelId,
                channelId: thread.channelId,
                threadTs: thread.threadTs,
                date: thread.lastActivityTs
                  ? new Date(Number(thread.lastActivityTs) * 1000).toISOString().slice(0, 10)
                  : null,
                knowledgeBaseUrl: githubUrlFor(thread.channelId, thread.threadTs) ?? null,
              });
              if (decisions.length >= limit) break;
            }
            if (decisions.length >= limit) break;
          }
          return asText(decisions);
        }
        default:
          return asText({ error: `unknown tool: ${request.params.name}` });
      }
    } catch (err) {
      return asText({ error: String(err) });
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch(err => {
  process.stderr.write(`watchtower-conversations MCP server failed to start: ${String(err)}\n`);
  process.exit(1);
});
