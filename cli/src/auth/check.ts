import { resolveConfig } from "../config.js";

export function checkAuth(config?: { env?: NodeJS.ProcessEnv }) {
  const resolved = resolveConfig({ env: config?.env });
  const configured = Boolean(resolved.apiKey);
  return {
    ok: configured,
    configured,
    source: configured ? "env" : "missing",
  } as const;
}
