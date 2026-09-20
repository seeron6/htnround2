// One worker per loaded head. Jobs contain independent, non-damaging live
// contacts; persistent clay/damage continues through the ordered local path.
import { impactCacheKey } from './impact-cache.js';

export class ImpactPreparation {
  constructor(
    model,
    {
      makeWorker = () =>
        new Worker(new URL('./impact-worker.js', import.meta.url), { type: 'module' }),
    } = {},
  ) {
    this.worker = makeWorker();
    this.pending = new Map();
    this.byKey = new Map();
    this.waiting = [];
    this.inFlight = 0;
    this.cache = new Map();
    this.sequence = 0;
    this.epoch = 0;
    this.disposed = false;
    this.worker.onmessage = ({ data }) => {
      if (this.disposed || data.epoch !== this.epoch) return;
      if (data.type === 'cache') {
        this.remember(data.key, data);
        return;
      }
      if (data.type === 'ready') {
        if (data.error) this.fail();
        else this.resolveReady?.();
        return;
      }
      const job = this.pending.get(data.id);
      if (!job) return;
      if (data.stage === 'complete' && data.event) this.remember(job.key, data);
      if (data.stage === 'preview') job.preview = data;
      else {
        this.pending.delete(data.id);
        this.byKey.delete(job.key);
        this.inFlight--;
      }
      // Each contact owns its age/refinement, even when its expensive pose is shared.
      for (const callback of job.callbacks) this.deliver(callback, data);
      this.drain();
    };
    this.worker.onerror = () => this.fail();
    this.configure(model);
  }

  configure(model) {
    this.invalidate();
    this.cache.clear();
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    this.worker.postMessage({ type: 'init', epoch: this.epoch, ...model });
  }

  request(input, softness, reactionEnabled, callback) {
    if (this.disposed || this.failed) return false;
    const key = impactCacheKey(input, softness, reactionEnabled);
    const cached = this.cache.get(key);
    if (cached) {
      callback({
        ...cached,
        stage: 'complete',
        milliseconds: 0,
        cached: true,
        event: { ...cached.event, age: 0, committed: 0 },
      });
      return true;
    }
    const pending = this.byKey.get(key);
    if (pending) {
      pending.callbacks.push(callback);
      if (pending.preview) this.deliver(callback, pending.preview);
      return true;
    }
    const id = ++this.sequence;
    const message = {
      type: 'impact',
      epoch: this.epoch,
      id,
      input,
      softness,
      reactionEnabled,
    };
    const job = { callbacks: [callback], key, message };
    this.pending.set(id, job);
    this.byKey.set(key, job);
    this.waiting.push(job);
    this.drain();
    return true;
  }

  deliver(callback, result) {
    callback({
      ...result,
      event: result.event ? { ...result.event, age: 0, committed: 0 } : undefined,
    });
  }

  drain() {
    // Bound worker work in flight, not the number of valid punches. Waiting
    // requests are tiny; matching contacts share a solve and retain every callback.
    while (!this.disposed && !this.failed && this.inFlight < 4 && this.waiting.length) {
      this.inFlight++;
      this.worker.postMessage(this.waiting.shift().message);
    }
  }

  invalidate() {
    this.resolveReady?.();
    this.epoch++;
    this.pending.clear();
    this.byKey.clear();
    this.waiting.length = 0;
    this.inFlight = 0;
  }

  remember(key, result) {
    this.cache.delete(key);
    this.cache.set(key, result);
    if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value);
  }

  fail() {
    if (this.disposed || this.failed) return;
    this.failed = true;
    this.resolveReady?.();
    this.worker.terminate();
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    this.byKey.clear();
    this.waiting.length = 0;
    this.inFlight = 0;
    for (const job of callbacks)
      for (const callback of job.callbacks)
        callback({ error: 'Impact worker unavailable' });
  }

  dispose() {
    this.disposed = true;
    this.invalidate();
    this.worker.terminate();
  }
}
