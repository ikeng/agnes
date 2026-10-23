/** Shared zod schema / helpers for per-request routing options. */
import { z } from "zod";
import { ROUTING_STRATEGIES, type RoutingInfo, type RoutingStrategy } from "./types.js";

/** `route` accepted by every generation/status option object (design §3/§4). */
export const routeOptionsSchema = z
  .object({
    accountId: z.string().min(1).optional(),
    poolId: z.string().min(1).optional(),
    affinityKey: z.string().min(1).optional(),
    strategy: z.enum(ROUTING_STRATEGIES).optional(),
    workload: z.enum(["text", "image", "video", "status"]).optional(),
    model: z.string().min(1).optional(),
    size: z.string().min(1).optional(),
  })
  .optional();

export type RouteOptionsInput = z.infer<typeof routeOptionsSchema>;

/** Build redacted routing provenance for results. */
export function routingInfo(
  result: { attempts: number; waitedMs: number; fallback: boolean },
  strategy: RoutingStrategy,
): RoutingInfo {
  return {
    strategy,
    attempts: result.attempts,
    waitedMs: result.waitedMs,
    fallback: result.fallback,
  };
}
