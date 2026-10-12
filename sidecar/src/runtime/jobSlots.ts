import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkflowStepLogger } from '../types/contracts.js';

/**
 * Concurrency slots for jobs, with a lease a waiting job can hand back
 * (issue #434).
 *
 * The sidecar runs a few jobs at a time. A job used to keep its slot until
 * its whole workflow returned, including the hours it spent waiting for
 * someone to type "yes" to a plan. Three unapproved plans stopped miniOG for
 * everyone: questions and review asks sat in the queue behind jobs that were
 * doing nothing. The longest wait was three and a half hours.
 *
 * A job that is only waiting on a person gives its slot up for the wait and
 * takes one back when the answer comes, ahead of anything still queued: it
 * was here first, and its requester has just been answered.
 */

interface SlotHolder {
  /** False while the job has lent its slot out for a wait. */
  held: boolean;
}

export class JobSlots {
  private running = 0;
  /** Jobs whose wait is over and that need a slot back. Served before the queue. */
  private readonly returning: Array<() => void> = [];
  private readonly context = new AsyncLocalStorage<SlotHolder>();
  private max: () => number = () => Number.POSITIVE_INFINITY;
  private onFree: () => void = () => {};

  /** `max` is read on every decision, so a settings change applies at once. `onFree` restarts the queue. */
  configure(options: { max: () => number; onFree: () => void }): void {
    this.max = options.max;
    this.onFree = options.onFree;
  }

  /** Slots in use by jobs that are doing something. */
  get active(): number {
    return this.running;
  }

  /** Jobs whose wait is over, waiting for a slot. */
  get waitingToReturn(): number {
    return this.returning.length;
  }

  /**
   * For the queue: take a slot for a new job. Refused while a job is waiting
   * to come back, so a returning job is never overtaken by the queue.
   */
  tryAcquire(): boolean {
    if (this.returning.length > 0 || this.running >= this.max()) return false;
    this.running += 1;
    return true;
  }

  /** Runs a job in the slot `tryAcquire` just took, and gives the slot back when the job ends. */
  async run<T>(job: () => Promise<T>): Promise<T> {
    const holder: SlotHolder = { held: true };
    try {
      return await this.context.run(holder, job);
    } finally {
      if (holder.held) this.free();
    }
  }

  /**
   * Wraps a wait on a person. The calling job's slot is free for the length
   * of the wait and taken back before this returns. Outside a job slot (a
   * test, a wait inside a wait) it only runs the wait.
   */
  async whileWaitingOnHuman<T>(
    wait: () => Promise<T>,
    options: { signal?: AbortSignal; logStep?: WorkflowStepLogger } = {},
  ): Promise<T> {
    const holder = this.context.getStore();
    if (!holder?.held) return wait();

    holder.held = false;
    this.free();
    try {
      return await wait();
    } finally {
      const startedAt = Date.now();
      const queued = !this.canTakeNow(options.signal);
      if (queued) {
        options.logStep?.({
          stage: 'job.slot.waiting',
          message: 'Got the answer — waiting for a free job slot to carry on.',
          data: { active: this.running, max: this.max() },
        });
      }
      await this.takeBack(options.signal);
      holder.held = true;
      if (queued) {
        options.logStep?.({
          stage: 'job.slot.resumed',
          message: 'Job slot free — carrying on.',
          data: { waitedMs: Date.now() - startedAt },
        });
      }
    }
  }

  private canTakeNow(signal?: AbortSignal): boolean {
    // A cancelled job has only its ending left to do. It does not queue for that.
    return Boolean(signal?.aborted) || this.running < this.max();
  }

  private takeBack(signal?: AbortSignal): Promise<void> {
    if (this.canTakeNow(signal)) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const granted = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        const at = this.returning.indexOf(granted);
        if (at === -1) return; // already granted a slot
        this.returning.splice(at, 1);
        this.running += 1;
        resolve();
      };
      this.returning.push(granted);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private free(): void {
    this.running -= 1;
    const next = this.returning.shift();
    if (next) {
      // Handed straight to a returning job: the slot never looks free to the queue.
      this.running += 1;
      next();
      return;
    }
    this.onFree();
  }
}

/** The sidecar's one set of job slots. `index.ts` configures it; the human-gate waits lend to it. */
export const jobSlots = new JobSlots();
