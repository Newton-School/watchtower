import { describe, expect, it } from 'vitest';
import { requesterOf } from '../src/workflows/shared/requester.js';

describe('requesterOf', () => {
  it('is the person a run started for someone else is for, and the sender otherwise', () => {
    expect(requesterOf({ event: { userId: 'UOWNER', requestedForUserId: 'UASKER' } })).toBe('UASKER');
    expect(requesterOf({ event: { userId: 'UASKER' } })).toBe('UASKER');
  });
});
