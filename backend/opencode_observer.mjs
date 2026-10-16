import { writeFileSync, renameSync } from "node:fs";

function observe(read, dispose) {
  const path = process.env.CC_WEB_OPENCODE_OBSERVATION;
  const run = process.env.CC_WEB_AGENT_RUN;
  if (!path || !run) return;
  let previous, order = 0, lastWrite = 0;
  const sample = () => {
    try {
      const current = read();
      const value = JSON.stringify(current);
      if (value === previous && Date.now() - lastWrite < 1000) return;
      const temporary = path + "." + process.pid + ".tmp";
      writeFileSync(temporary, JSON.stringify({ ...current, run, pid: process.pid, order: ++order, at: Date.now() / 1000 }), { mode: 0o600 });
      renameSync(temporary, path);
      previous = value;
      lastWrite = Date.now();
    } catch { /* Tracking must never change terminal input or model calls. */ }
  };
  sample();
  const timer = setInterval(sample, 150);
  timer.unref?.();
  const cleanup = () => { sample(); clearInterval(timer); };
  dispose?.(cleanup);
  return cleanup;
}

export default {
  id: "cc-web-current-conversation",
  tui(api) {
    return observe(() => {
      const route = api.route.current;
      return { session_id: route.name === "session" ? route.params?.sessionID : null,
        cwd: api.state.path.directory };
    }, fn => api.lifecycle.onDispose(fn));
  },
  setup(context) {
    return observe(() => {
      const route = context.ui.router.current();
      return { session_id: route.type === "session" ? route.sessionID : null,
        cwd: context.location?.directory };
    });
  },
};
