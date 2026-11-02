// Compatibility API for movie callers: track work, but never queue users.
// Individual resolver/transfer operations have their own deadlines and stall
// guards. A Promise.race timeout here cannot cancel a download, and could
// delete its output while it is still being written or uploaded.
import { log } from './log.js';

const qlog = log.child('jobs');

class JobQueue {
  constructor() { this.running = 0; }

  async add(_jid, label, job) {
    if (typeof job !== 'function') throw new TypeError('job must be a function');
    this.running++;
    const started = Date.now();
    try { return await job(); }
    finally {
      this.running--;
      qlog.debug(`job "${label}" took ${Date.now() - started}ms`);
    }
  }

  get size() { return 0; }
  get busy() { return this.running; }
  position() { return 0; }
}

export default new JobQueue();
export { JobQueue };
