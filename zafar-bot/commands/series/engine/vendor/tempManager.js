// Per-command shim for the single call the engine makes into the old tempManager.
// The job folder belongs to this command's child process and nothing else holds
// files in it, so "not held" is the truthful answer.
function isHeld() { return false; }
function getTempDir() { return process.env.TEMP_DIR || '.'; }
const api = { isHeld, getTempDir };
export default api;
export { isHeld, getTempDir };
