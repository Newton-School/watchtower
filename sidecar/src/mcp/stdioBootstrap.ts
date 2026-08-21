/**
 * MUST be the first import of the stdio MCP entrypoint. ESM executes imports
 * in order, so setting this before any module that pulls in the shared pino
 * logger guarantees logs go to stderr — stdout belongs to the JSON-RPC
 * protocol and a single log line there corrupts the session.
 */
process.env.WATCHTOWER_LOG_STDERR = '1';

export {};
