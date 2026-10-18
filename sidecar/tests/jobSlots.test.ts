import { describe, expect, it, vi } from 'vitest';
import { JobSlots, jobSlots } from '../src/runtime/jobSlots.js';
import { waitForApproval } from '../src/agents/pipeline.js';
import { __confirmationTiming, waitForExactConfirmation } from '../src/workflows/shared/confirmationGate.js';

vi.mock('../src/slack/threadContext.js', () => ({
  fetchThreadContext: vi.fn().mockResolvedValue([]),
  fetchThreadRepliesSince: vi.fn().mockResolvedValue([]),
}));

/** A promise the test settles by hand, standing in for "the person replied". */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function makeSlots(max: number) {
  const slots = new JobSlots();
  const onFree = vi.fn();
  slots.configure({ max: () => max, onFree });
  return { slots, onFree };
}

describe('JobSlots (issue #434)', () => {
  it('does not queue for a slot when the answer ends the job (issue #598)', async () => {
    const { slots } = makeSlots(1);
    const answer = deferred<string>();
    const other = deferred();

    expect(slots.tryAcquire()).toBe(true);
    const stopped = slots.run(() =>
      slots.whileWaitingOnHuman(() => answer.promise, { endsJob: result => result === 'stop' }),
    );
    await tick();
    // The freed slot goes to another job that keeps it for a long time.
    expect(slots.tryAcquire()).toBe(true);
    const busy = slots.run(() => other.promise);

    answer.resolve('stop');
    expect(await stopped).toBe('stop');
    expect(slots.active).toBe(1);

    other.resolve();
    await busy;
    expect(slots.active).toBe(0);
  });

  it('runs at most the configured number of jobs and frees a slot when one ends', async () => {
    const { slots, onFree } = makeSlots(2);
    const first = deferred();

    expect(slots.tryAcquire()).toBe(true);
    const running = slots.run(() => first.promise);
    expect(slots.tryAcquire()).toBe(true);
    expect(slots.tryAcquire()).toBe(false);
    expect(slots.active).toBe(2);

    first.resolve();
    await running;

    expect(slots.active).toBe(1);
    expect(onFree).toHaveBeenCalledTimes(1);
  });

  it('frees the slot of a job that is only waiting on a person, and takes it back when the answer comes', async () => {
    // The incident: three unapproved plans held all three slots for hours.
    const { slots, onFree } = makeSlots(1);
    const answer = deferred<string>();
    const seen: number[] = [];

    expect(slots.tryAcquire()).toBe(true);
    const job = slots.run(async () => {
      seen.push(slots.active); // working
      const reply = await slots.whileWaitingOnHuman(() => answer.promise);
      seen.push(slots.active); // working again
      return reply;
    });
    await tick();

    // Waiting for "yes": the slot is free and the queue was told.
    expect(slots.active).toBe(0);
    expect(onFree).toHaveBeenCalledTimes(1);
    expect(slots.tryAcquire()).toBe(true); // someone else's question gets in
    expect(slots.active).toBe(1);

    answer.resolve('yes');
    await tick();
    // The answer is in, but the other job still has the only slot.
    expect(slots.waitingToReturn).toBe(1);

    // The other job ends: its slot goes straight back to the waiting job.
    await slots.run(async () => {});
    expect(await job).toBe('yes');
    expect(seen).toEqual([1, 1]);
    expect(slots.active).toBe(0);
  });

  it('lets a returning job go ahead of the queue', async () => {
    const { slots, onFree } = makeSlots(1);
    const answer = deferred();
    const other = deferred();

    slots.tryAcquire();
    const waiter = slots.run(() => slots.whileWaitingOnHuman(() => answer.promise));
    await tick();
    slots.tryAcquire();
    const busy = slots.run(() => other.promise);
    answer.resolve();
    await tick();
    onFree.mockClear();

    // While a job is waiting to come back, the queue cannot take a slot, even a free one.
    expect(slots.tryAcquire()).toBe(false);
    other.resolve();
    await busy;

    // The freed slot went to the returning job, not to the queue.
    expect(onFree).not.toHaveBeenCalled();
    await waiter;
    expect(onFree).toHaveBeenCalledTimes(1);
    expect(slots.active).toBe(0);
  });

  it('takes its slot back at once when one is free', async () => {
    const { slots } = makeSlots(2);
    const logStep = vi.fn();

    slots.tryAcquire();
    await slots.run(() => slots.whileWaitingOnHuman(async () => 'ok', { logStep }));

    // No waiting, so nothing to tell the thread about.
    expect(logStep).not.toHaveBeenCalled();
    expect(slots.active).toBe(0);
  });

  it('says so when the answer is in but every slot is busy, and again when it carries on', async () => {
    const { slots } = makeSlots(1);
    const answer = deferred();
    const other = deferred();
    const logStep = vi.fn();

    slots.tryAcquire();
    const waiter = slots.run(() => slots.whileWaitingOnHuman(() => answer.promise, { logStep }));
    await tick();
    slots.tryAcquire();
    const busy = slots.run(() => other.promise);
    answer.resolve();
    await tick();

    expect(logStep).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stage: 'job.slot.waiting' }));
    other.resolve();
    await busy;
    await waiter;
    expect(logStep).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'job.slot.resumed' }));
  });

  it('does not make a cancelled job queue for a slot just to finish', async () => {
    const { slots } = makeSlots(1);
    const controller = new AbortController();
    const answer = deferred();
    const other = deferred();

    slots.tryAcquire();
    const waiter = slots.run(() => slots.whileWaitingOnHuman(() => answer.promise, { signal: controller.signal }));
    await tick();
    slots.tryAcquire();
    const busy = slots.run(() => other.promise);

    // Cancelled while it waited, with the only slot taken by another job.
    controller.abort();
    answer.resolve();
    await waiter;

    expect(slots.active).toBe(1); // back to the one job that is really running
    other.resolve();
    await busy;
    expect(slots.active).toBe(0);
  });

  it('lets a job that is cancelled while queued for its slot leave the queue', async () => {
    const { slots } = makeSlots(1);
    const controller = new AbortController();
    const answer = deferred();
    const other = deferred();

    slots.tryAcquire();
    const waiter = slots.run(() => slots.whileWaitingOnHuman(() => answer.promise, { signal: controller.signal }));
    await tick();
    slots.tryAcquire();
    const busy = slots.run(() => other.promise);
    answer.resolve();
    await tick();
    expect(slots.waitingToReturn).toBe(1);

    controller.abort();
    await waiter;

    expect(slots.waitingToReturn).toBe(0);
    expect(slots.tryAcquire()).toBe(false); // the other job still has the slot
    other.resolve();
    await busy;
    expect(slots.active).toBe(0);
    expect(slots.tryAcquire()).toBe(true);
  });

  it('gives the slot back even when the wait throws', async () => {
    const { slots } = makeSlots(1);

    slots.tryAcquire();
    await expect(
      slots.run(() =>
        slots.whileWaitingOnHuman(async () => {
          throw new Error('slack down');
        }),
      ),
    ).rejects.toThrow('slack down');

    expect(slots.active).toBe(0);
    expect(slots.tryAcquire()).toBe(true);
  });

  it('releases once for a wait inside a wait, and only runs the wait when there is no job slot', async () => {
    const { slots, onFree } = makeSlots(1);

    slots.tryAcquire();
    await slots.run(() => slots.whileWaitingOnHuman(() => slots.whileWaitingOnHuman(async () => 'inner')));
    // Freed for the outer wait and at the end of the job. Not a third time for the inner wait.
    expect(onFree).toHaveBeenCalledTimes(2);
    expect(slots.active).toBe(0);

    // Called from outside any job (a unit test of a wait): nothing to lend.
    expect(await slots.whileWaitingOnHuman(async () => 'plain')).toBe('plain');
    expect(slots.active).toBe(0);
  });

  it('reads the limit each time, so a settings change applies without a restart', () => {
    const slots = new JobSlots();
    let max = 1;
    slots.configure({ max: () => max, onFree: () => {} });

    expect(slots.tryAcquire()).toBe(true);
    expect(slots.tryAcquire()).toBe(false);
    max = 2;
    expect(slots.tryAcquire()).toBe(true);
  });
});

describe('the waits on a person lend their slot (issue #434)', () => {
  const slack = { chat: { postMessage: vi.fn().mockResolvedValue({ ok: true }) } };

  it('frees the slot while a plan waits for approval', async () => {
    const onFree = vi.fn();
    jobSlots.configure({ max: () => 1, onFree });
    const controller = new AbortController();

    expect(jobSlots.tryAcquire()).toBe(true);
    const job = jobSlots.run(() =>
      waitForApproval({
        slack: slack as never,
        channelId: 'C1',
        threadTs: '1.1',
        approverUserIds: ['UADMIN'],
        triggerUserId: 'U1',
        approvalPromptTs: '1.2',
        logStep: vi.fn(),
        signal: controller.signal,
      }),
    );
    await tick();

    expect(jobSlots.active).toBe(0);
    expect(onFree).toHaveBeenCalledTimes(1);

    controller.abort();
    expect((await job).outcome).toBe('cancelled');
    expect(jobSlots.active).toBe(0);
  });

  it('frees the slot while a deploy or merge waits for its confirmation phrase', async () => {
    jobSlots.configure({ max: () => 1, onFree: () => {} });
    const saved = { ...__confirmationTiming };
    __confirmationTiming.pollMs = 5;
    __confirmationTiming.deadlineMs = 40;

    expect(jobSlots.tryAcquire()).toBe(true);
    const job = jobSlots.run(() =>
      waitForExactConfirmation({
        slack: slack as never,
        channelId: 'C1',
        threadTs: '1.1',
        promptTs: '1.2',
        phrase: 'confirm deploy',
        allowedUserIds: ['U1'],
        stagePrefix: 'deploy.confirm',
      }),
    );
    await tick();
    expect(jobSlots.active).toBe(0);

    expect((await job).outcome).toBe('expired');
    Object.assign(__confirmationTiming, saved);
    expect(jobSlots.active).toBe(0);
  });
});
