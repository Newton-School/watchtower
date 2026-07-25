import { describe, expect, it } from 'vitest';
import { hasDevAssistCommand, parseDevAssistCommand } from '../src/router/devAssistParser.js';

describe('devAssistParser', () => {
  it('parses wt help commands', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt help')).toEqual({ type: 'HELP' });
    expect(parseDevAssistCommand('<@UBOT1> watchtower help')).toEqual({ type: 'HELP' });
    expect(parseDevAssistCommand('<@UBOT1> wt')).toEqual({ type: 'HELP' });
  });

  it('parses wt status command', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt status')).toEqual({ type: 'STATUS' });
  });

  it('parses wt runs command with optional limit', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt runs')).toEqual({ type: 'RUNS', limit: 5 });
    expect(parseDevAssistCommand('<@UBOT1> wt runs 8')).toEqual({ type: 'RUNS', limit: 8 });
  });

  it('parses wt failures command with optional limit', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt failures')).toEqual({ type: 'FAILURES', limit: 5 });
    expect(parseDevAssistCommand('<@UBOT1> wt failures 9')).toEqual({ type: 'FAILURES', limit: 9 });
  });

  it('parses wt trace command with optional lines', () => {
    // Default raised to 60: a per-tool-call trail makes a 20-line tail useless.
    expect(parseDevAssistCommand('<@UBOT1> wt trace abc123')).toEqual({
      type: 'TRACE',
      jobId: 'abc123',
      limit: 60,
    });
    expect(parseDevAssistCommand('<@UBOT1> wt trace abc123 40')).toEqual({
      type: 'TRACE',
      jobId: 'abc123',
      limit: 40,
    });
  });

  it('parses wt diagnose command', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt diagnose abc123')).toEqual({
      type: 'DIAGNOSE',
      jobId: 'abc123',
    });
  });

  it('parses wt learn command', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt learn')).toEqual({
      type: 'LEARN',
    });
  });

  it('parses wt heat command with optional limit', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt heat')).toEqual({
      type: 'HEAT',
      limit: 5,
    });
    expect(parseDevAssistCommand('<@UBOT1> wt heat 7')).toEqual({
      type: 'HEAT',
      limit: 7,
    });
  });

  it('does not parse removed personality commands', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt personality set friendly me')).toBeUndefined();
    expect(parseDevAssistCommand('<@UBOT1> wt personality show channel')).toBeUndefined();
  });

  it('parses wt mission commands', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt mission start stabilize checkout latency')).toEqual({
      type: 'MISSION_START',
      goal: 'stabilize checkout latency',
    });
    expect(parseDevAssistCommand('<@UBOT1> wt mission show')).toEqual({
      type: 'MISSION_SHOW',
    });
    expect(parseDevAssistCommand('<@UBOT1> wt mission run --swarm')).toEqual({
      type: 'MISSION_RUN_SWARM',
    });
  });

  it('parses wt trust command', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt trust channel execute')).toEqual({
      type: 'TRUST_SET',
      target: 'channel',
      level: 'execute',
    });
    expect(parseDevAssistCommand('<@UBOT1> wt trust user suggest')).toEqual({
      type: 'TRUST_SET',
      target: 'user',
      level: 'suggest',
    });
  });

  it('parses wt replay and wt fork commands', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt replay abc123')).toEqual({
      type: 'REPLAY',
      jobId: 'abc123',
    });
    expect(parseDevAssistCommand('<@UBOT1> wt fork abc123')).toEqual({
      type: 'FORK',
      jobId: 'abc123',
    });
  });

  it('parses wt skill commands', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt skill install frontend-pr-review')).toEqual({
      type: 'SKILL_INSTALL',
      name: 'frontend-pr-review',
    });
    expect(parseDevAssistCommand('<@UBOT1> wt skill use frontend-pr-review')).toEqual({
      type: 'SKILL_USE',
      name: 'frontend-pr-review',
    });
  });

  it('parses wt feed commands', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt feed on')).toEqual({
      type: 'FEED_SET',
      enabled: true,
    });
    expect(parseDevAssistCommand('<@UBOT1> wt feed off')).toEqual({
      type: 'FEED_SET',
      enabled: false,
    });
  });

  it('parses wt digest commands', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt digest 9:30')).toEqual({
      type: 'DIGEST_SET',
      enabled: true,
      time: '9:30',
    });
    expect(parseDevAssistCommand('<@UBOT1> wt digest off')).toEqual({
      type: 'DIGEST_SET',
      enabled: false,
    });
  });

  it('parses wt policy commands', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt policy import frontend')).toEqual({
      type: 'POLICY_IMPORT',
      pack: 'frontend',
    });
    expect(parseDevAssistCommand('<@UBOT1> wt policy show')).toEqual({
      type: 'POLICY_SHOW',
    });
  });

  it('parses wt incident commands', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt incident on')).toEqual({
      type: 'INCIDENT_SET',
      enabled: true,
    });
    expect(parseDevAssistCommand('<@UBOT1> wt incident off')).toEqual({
      type: 'INCIDENT_SET',
      enabled: false,
    });
  });

  it('parses wt my queue command', () => {
    expect(parseDevAssistCommand('<@UBOT1> wt my queue')).toEqual({
      type: 'MY_QUEUE',
      limit: 5,
    });
    expect(parseDevAssistCommand('<@UBOT1> wt my queue 9')).toEqual({
      type: 'MY_QUEUE',
      limit: 9,
    });
  });

  it('parses natural-language aliases for learn/status/queue/heat/failures', () => {
    expect(parseDevAssistCommand('<@UBOT1> what did you learn?')).toEqual({
      type: 'LEARN',
    });
    expect(parseDevAssistCommand('<@UBOT1> status')).toEqual({
      type: 'STATUS',
    });
    expect(parseDevAssistCommand('<@UBOT1> my queue')).toEqual({
      type: 'MY_QUEUE',
      limit: 5,
    });
    expect(parseDevAssistCommand('<@UBOT1> hot channels')).toEqual({
      type: 'HEAT',
      limit: 5,
    });
    expect(parseDevAssistCommand('<@UBOT1> recent errors')).toEqual({
      type: 'FAILURES',
      limit: 5,
    });
  });

  it('does not treat arbitrary chat text as a natural-language alias', () => {
    expect(parseDevAssistCommand('<@UBOT1> status report for the PR')).toBeUndefined();
    expect(parseDevAssistCommand('<@UBOT1> this queue is cursed today')).toBeUndefined();
    expect(parseDevAssistCommand('<@UBOT1> failures are expected in default mode')).toBeUndefined();
  });

  it('detects dev-assist prefix only when present', () => {
    expect(hasDevAssistCommand('<@UBOT1> wt help')).toBe(true);
    expect(hasDevAssistCommand('1. <@UBOT1> wt help')).toBe(true);
    expect(hasDevAssistCommand('- <@UBOT1> wt help')).toBe(true);
    expect(hasDevAssistCommand('<@UBOT1> please review this PR')).toBe(false);
  });
});
