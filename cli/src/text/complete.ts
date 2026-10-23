import { z } from "zod";
import type { AgnesClientConfig } from "../config.js";
import { resolveClientConfig } from "../config.js";
import { AgnesCliError } from "../errors.js";
import { requestJson } from "../http/requestJson.js";
import { DEFAULT_TEXT_MODEL } from "../models.js";
import { routeOptionsSchema, routingInfo } from "../accounts/route.js";
import type { RoutingInfo } from "../accounts/types.js";

const textCompleteSchema = z.object({
  model: z.string().default(DEFAULT_TEXT_MODEL),
  prompt: z.string().min(1),
  stream: z.boolean().optional(),
  route: routeOptionsSchema,
});

export type TextCompleteOptions = z.infer<typeof textCompleteSchema>;

export interface TextCompletionResult {
  [key: string]: unknown;
  ok: true;
  model: string;
  text: string;
  raw: unknown;
  accountId?: string;
  poolId?: string;
  routing?: RoutingInfo;
}

export async function completeText(
  options: TextCompleteOptions,
  config: AgnesClientConfig = {},
): Promise<TextCompletionResult> {
  const parsed = textCompleteSchema.parse(options);
  const resolved = resolveClientConfig(config);
  if (!resolved.apiKey) {
    throw new AgnesCliError("AUTH_MISSING", "AGNES_API_KEY is required for Agnes requests.");
  }

  const payload = {
    model: parsed.model,
    messages: [{ role: "user", content: parsed.prompt }],
    ...(parsed.stream ? { stream: true } : {}),
  };

  const routed = await resolved.router.execute(
    {
      ...(parsed.route ?? {}),
      workload: "text",
      model: parsed.model,
      method: "POST",
    },
    (account) =>
      requestJson(
        resolved.fetchImpl,
        `${(account.baseUrl ?? resolved.baseUrl).replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${account.key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
        {
          networkMessage: "Agnes text request failed before a response was received.",
          retries: 0,
        },
      ),
  );
  const { response, raw } = routed.value;
  if (!response.ok) {
    throw new AgnesCliError("AGNES_REQUEST_FAILED", `Agnes text request failed with HTTP ${response.status}.`, raw);
  }
  const text = extractText(raw);
  if (!text) {
    throw new AgnesCliError("TEXT_MISSING", "Agnes text response did not include assistant content.", raw);
  }
  return {
    ok: true,
    model: parsed.model,
    text,
    raw,
    accountId: routed.accountId,
    poolId: routed.poolId,
    routing: routingInfo(routed, routedStrategy(resolved, parsed.route)),
  };
}

function routedStrategy(
  resolved: ReturnType<typeof resolveClientConfig>,
  route: TextCompleteOptions["route"],
): import("../accounts/types.js").RoutingStrategy {
  return route?.strategy ?? resolved.router.config.strategy;
}

function extractText(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return undefined;
  const message = (first as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}
