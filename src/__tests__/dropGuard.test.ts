import { describe, expect, it } from 'vitest';
import { installDropGuard } from '../lib/dropGuard';

function fileDrag(type: 'dragover' | 'drop', alreadyTaken = false): Event {
  const event = new Event(type, { cancelable: true }) as Event & { dataTransfer: unknown };
  event.dataTransfer = { types: ['Files'], dropEffect: 'copy' };
  if (alreadyTaken) event.preventDefault();
  return event;
}

describe('installDropGuard', () => {
  it('refuses file drops nothing on the page took, so the window never opens the file', () => {
    const remove = installDropGuard(window);
    const drop = fileDrag('drop');
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);

    const over = fileDrag('dragover') as Event & { dataTransfer: { dropEffect: string } };
    window.dispatchEvent(over);
    expect(over.dataTransfer.dropEffect).toBe('none');

    // The reply box takes its own drops; the guard leaves those alone.
    const taken = fileDrag('dragover', true) as Event & { dataTransfer: { dropEffect: string } };
    window.dispatchEvent(taken);
    expect(taken.dataTransfer.dropEffect).toBe('copy');
    remove();
  });
});
