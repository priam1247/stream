'use strict';

/**
 * gateway/runner.js — runs each command in its own child process.
 *
 * Why: a hang or crash inside one command must kill only that process. A
 * require() that throws, an infinite loop, a `process.exit()`, an OOM — none of
 * them reach the gateway.
 *
 * Protocol (newline-delimited JSON over IPC, no stdout parsing):
 *   child -> parent  { type:'ready' }
 *                    { type:'send',  id, kind, payload }
 *                    { type:'log',   level, message }
 *   parent -> child  { type:'run',   job }
 *                    { type:'result',id, ok, value, error }
 *                    { type:'shutdown' }
 *
 * The gateway owns every socket detail. The child only ever asks it to send.
 */

const { fork } = require('child_process');
const path = require('path');
const { gatewayLog } = require('./log');

const CHILD = path.join(__dirname, 'child.js');

class RunnerError extends Error {
  constructor(message, { timeout = false, code = 'RUNNER_FAILED', cause } = {}) {
    super(message);
    this.name = 'RunnerError';
    this.timeout = timeout;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/**
 * @param {object} job
 * @param {string} job.name         command name
 * @param {string} job.folderPath   absolute path to the command folder
 * @param {number} job.timeoutSec   hard kill
 * @param {object} job.ctx          plain-data ctx (no functions)
 * @param {Map<string,string>} job.env  extra env for the child
 * @param {(kind:string,payload:object)=>Promise<any>} job.transport
 * @returns {Promise<{ok:boolean, result?:any, error?:RunnerError, durationMs:number}>}
 */
async function run(job) {
  const started = Date.now();
  const timeoutMs = Math.max(1, Number(job.timeoutSec) || 30) * 1000;

  const child = fork(CHILD, [], {
    cwd: job.folderPath,
    env: {
      ...process.env,
      ...(job.env ? Object.fromEntries(job.env) : {}),
      // The child's only input. Passed through the environment so it exists
      // before any command module is required.
      ZAFAR_CTX: JSON.stringify(job.ctx),
      ZAFAR_COMMAND_DIR: job.folderPath,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
  });

  // stderr is captured in full: when a command dies from a syntax error or a
  // crash, that text IS the diagnosis. Dropping it would leave the status board
  // saying "exited before returning a result", which is exactly the useless
  // message this architecture is supposed to eliminate.
  const stderrChunks = [];

  const outcome = await new Promise((resolve) => {
    let settled = false;
    let ready = false;
    let doneReceived = false;
    void doneReceived;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.removeAllListeners(); } catch { /* already gone */ }
      try { if (child.connected) child.disconnect(); } catch { /* already gone */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve(value);
    };

    const timer = setTimeout(() => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      finish({
        ok: false,
        error: new RunnerError(
          `timed out after ${timeoutMs / 1000}s and was killed`,
          { timeout: true, code: 'TIMEOUT', cause: stderr ? new Error(stderr.split('\n').slice(-3).join(' | ')) : undefined },
        ),
      });
    }, timeoutMs);

    child.stderr?.on('data', (chunk) => stderrChunks.push(chunk));
    child.stdout?.on('data', () => { /* the child logs through IPC, stdout is noise */ });

    child.on('error', (err) => {
      finish({ ok: false, error: new RunnerError(`could not start command process: ${err.message}`, { code: 'SPAWN_FAILED', cause: err }) });
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      if (code === 0 && doneReceived) return; // handled by the done path
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      // Node prints the error line first and the require() stack after it, so
      // prefer the line that names the failure. Taking the last lines would put
      // "at Module._compile" in the user-facing reason, which is the worthless
      // message this architecture exists to remove.
      const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
      const errorLine = lines.find((l) => /^\w*Error\b/.test(l)) || lines.find((l) => /Error:/.test(l));
      const detail = errorLine
        ? `: ${errorLine}`
        : (lines.length ? `: ${lines.slice(-2).join(' | ')}` : '');
      finish({
        ok: false,
        error: new RunnerError(
          `command process exited (code ${code}, signal ${signal}) before returning a result${detail}`,
          { code: 'CHILD_EXIT', cause: stderr ? new Error(stderr) : undefined },
        ),
      });
    });

    child.on('message', async (msg) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ready') {
        ready = true;
        child.send({ type: 'run', job: job.ctx });
        return;
      }

      if (msg.type === 'log') {
        job.onLog?.(msg.level, msg.message);
        return;
      }

      if (msg.type === 'send') {
        try {
          const value = await job.transport(msg.kind, msg.payload);
          child.send({ type: 'result', id: msg.id, ok: true, value: value === undefined ? null : value });
        } catch (err) {
          child.send({ type: 'result', id: msg.id, ok: false, error: err.message });
        }
        return;
      }

      if (msg.type === 'done') {
        // The child deletes its job folder in a finally block AFTER sending
        // 'done'. Killing it now would race that cleanup, so wait for the exit
        // and only force the issue if it does not leave promptly.
        doneReceived = true;
        clearTimeout(timer);
        const force = setTimeout(() => finish({ ok: true, result: msg.result ?? null }), 5000);
        force.unref?.();
        child.once('exit', () => {
          clearTimeout(force);
          finish({ ok: true, result: msg.result ?? null });
        });
      }
    });

    // A child that never reports ready is caught by the same hard timeout.
    void ready;
  });

  const durationMs = Date.now() - started;
  if (!outcome.ok) {
    gatewayLog.error('command run failed', {
      command: job.name,
      durationMs,
      code: outcome.error.code,
      reason: outcome.error.message,
    });
  } else {
    gatewayLog.debug('command run ok', { command: job.name, durationMs });
  }

  return { ...outcome, durationMs };
}

module.exports = { run, RunnerError, CHILD };
