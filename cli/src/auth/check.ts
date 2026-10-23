import { resolveConfig, type AuthCheckResult, type ResolvedConfig } from "../config.js";

/**
 * Credential/routing summary used by `agnes auth check` and the JS API.
 *
 * Backward-compatible core fields (`ok`, `configured`, `source`) plus the
 * multi-account summary (`accounts`, `pools`, `strategy`). Key material is
 * never included.
 */
export function checkAuth(config?: { env?: NodeJS.ProcessEnv; apiKey?: string }): AuthCheckResult {
  const resolved = resolveConfig({
    ...(config?.env ? { env: config.env } : {}),
    ...(config?.apiKey ? { apiKey: config.apiKey } : {}),
  });
  return authCheckFromResolved(resolved);
}

/** Summarize an already-resolved configuration (keeps the client's router state). */
export function authCheckFromResolved(resolved: ResolvedConfig): AuthCheckResult {
  const configured = resolved.accountsConfig.accounts.length > 0;
  const source: AuthCheckResult["source"] = !configured
    ? "missing"
    : resolved.accountsConfig.source === "legacy"
      ? "env"
      : resolved.accountsConfig.source;
  return {
    ok: configured,
    configured,
    source,
    accounts: resolved.accountsConfig.accounts.length,
    pools: [...resolved.accountsConfig.pools],
    strategy: resolved.accountsConfig.strategy,
  };
}
