// Shared deadline handling for debrid API requests and polling.
export function requestSignal(signal, timeout = 15000) {
  const timed = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timed]) : timed;
}

export function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason || new Error('aborted')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
