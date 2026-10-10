import pino from 'pino';

const options = {
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined,
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
};

// WATCHTOWER_LOG_STDERR=1 diverts logs to stderr. Set by the stdio MCP server
// entrypoint, whose stdout carries the JSON-RPC protocol — a single pino line
// on stdout would corrupt it.
export const logger = process.env.WATCHTOWER_LOG_STDERR === '1' ? pino(options, pino.destination(2)) : pino(options);
