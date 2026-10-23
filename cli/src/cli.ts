import { Command } from "commander";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { saveKeyToShell } from "./auth/saveKey.js";
import { loadLocalEnv } from "./env.js";
import { createAgnesClient, type AgnesClient } from "./index.js";
import { isAgnesCliError, AgnesCliError } from "./errors.js";
import { resolveConfig, type AgnesClientConfig, type ResolvedConfig } from "./config.js";
import { registerAccountsCommands } from "./accounts/cli.js";
import { registerBatchCommands } from "./batch/cli.js";
import { ROUTING_STRATEGIES, type RouteOptions, type RoutingStrategy } from "./accounts/types.js";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_SIZE,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  IMAGE_RATIOS,
  IMAGE_SIZE_TIERS,
  isDeprecatedTextModel,
  isLegacyVideoModel,
  TEXT_MODELS,
  VIDEO_ASPECT_RATIOS,
  VIDEO_MODELS,
  VIDEO_SIZE_TIERS,
} from "./models.js";
import { printJson, printLines } from "./output.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export async function runCli(argv = process.argv): Promise<void> {
  // Pick up the nearest .env.local so the installed CLI works from this repo
  // without exporting AGNES_API_KEY in every shell. Explicit env wins.
  loadLocalEnv();

  const program = new Command();
  program
    .name("agnes")
    .description("CLI for Agnes AI text, image, and video workflows, with auth and media URL bridging")
    .version(pkg.version)
    .option("--account <id>", "Force one configured account for this invocation (disables failover)")
    .option(
      "--strategy <strategy>",
      `Routing strategy override for this invocation (${ROUTING_STRATEGIES.join(", ")})`,
    )
    .addHelpText("after", `
Examples:
  agnes models
  agnes auth check
  agnes accounts list
  agnes media url ./input.png
  agnes image text2img --prompt "A luminous city at sunrise" --size 2K --ratio 16:9
  agnes image img2img --image ./input.png --prompt "Turn this into an editorial campaign"
  agnes video text2video --prompt "A cinematic beach scene at sunset" --seconds 5 --size 720P
  agnes video keyframes --image ./a.png --image ./b.png --prompt "Transition between these frames"
  agnes video poll video_123 --model agnes-video-2.5
  agnes batch run jobs.json --out ./out

Multi-account routing:
  export AGNES_ACCOUNT_MAIN_KEY=sk-...       # indexed env accounts
  export AGNES_ACCOUNT_MAIN_TYPE=tokenplan
  agnes --strategy round-robin text chat --prompt "Reply with exactly pong."
  agnes --account main image text2img --prompt "A silver watch on black stone"

Models and docs: https://wiki.agnes-ai.com/llms.txt
`);

  // One resolved config + one client (one router) for the whole invocation:
  // cooldowns, token buckets and affinity stay shared across commands, but the
  // config is resolved lazily so --help/--version never need a valid account set.
  let cachedResolved: ResolvedConfig | undefined;
  let cachedClient: AgnesClient | undefined;
  const getResolved = (): ResolvedConfig => {
    if (!cachedResolved) {
      const globals = program.opts();
      const overrides: AgnesClientConfig = {};
      if (globals.strategy) overrides.strategy = parseStrategyFlag(globals.strategy);
      cachedResolved = resolveConfig(overrides);
    }
    return cachedResolved;
  };
  const getClient = (): AgnesClient => {
    if (!cachedClient) cachedClient = createAgnesClient(getResolved());
    return cachedClient;
  };
  const getRoute = (): RouteOptions => {
    const globals = program.opts();
    const route: RouteOptions = {};
    if (globals.account) route.accountId = String(globals.account).toLowerCase();
    if (globals.strategy) route.strategy = parseStrategyFlag(globals.strategy);
    return route;
  };
  const getRouteFor = (options: { affinity?: unknown }): RouteOptions => {
    const route = getRoute();
    const affinity = typeof options.affinity === "string" && options.affinity.trim() ? options.affinity.trim() : undefined;
    if (affinity) route.affinityKey = `session:${affinity}`;
    return route;
  };
  const printAccountNotice = (result: unknown): void => {
    const accountId = (result as { accountId?: unknown } | undefined)?.accountId;
    if (typeof accountId !== "string") return;
    if (getResolved().accountsConfig.accounts.length > 1) {
      // stdout stays machine-readable; the routing provenance notice goes to stderr.
      console.error(`account: ${accountId}`);
    }
  };

  registerAccountsCommands(program, { getResolved });
  registerBatchCommands(program, () => getClient());

  const models = program.command("models").description("List supported Agnes models and defaults");
  models
    .option("--json", "Output JSON")
    .action((options) => {
      const catalog = {
        ok: true,
        text: {
          default: DEFAULT_TEXT_MODEL,
          models: TEXT_MODELS.map((id) => ({
            id,
            status: isDeprecatedTextModel(id) ? "deprecated" : "current",
          })),
        },
        image: {
          default: DEFAULT_IMAGE_MODEL,
          models: IMAGE_MODELS.map((id) => ({
            id,
            status: id === "agnes-image-2.0-flash" ? "legacy" : "current",
          })),
        },
        video: {
          default: DEFAULT_VIDEO_MODEL,
          models: VIDEO_MODELS.map((id) => ({
            id,
            status: isLegacyVideoModel(id) ? "retired" : "current",
          })),
        },
        docs: "https://wiki.agnes-ai.com/llms.txt",
      };
      if (options.json) {
        printJson(catalog);
        return;
      }
      printLines([
        `text   default=${catalog.text.default}  [${formatModels(catalog.text.models, catalog.text.default)}]`,
        `image  default=${catalog.image.default}  [${formatModels(catalog.image.models, catalog.image.default)}]`,
        `video  default=${catalog.video.default}  [${formatModels(catalog.video.models, catalog.video.default)}]`,
        `docs   ${catalog.docs}`,
      ]);
    });

  const auth = program.command("auth").description("Inspect and configure Agnes auth");
  auth.addHelpText("after", `
Examples:
  agnes auth check
  agnes auth save-key --key sk-...

Use this group to verify AGNES_API_KEY or persist it into the active shell rc file.
With AGNES_ACCOUNT_* configured, auth check also reports the pool/account summary.
`);
  auth
    .command("check")
    .description("Check whether Agnes credentials are configured")
    .option("--json", "Output JSON")
    .action((options) => {
      const result = getClient().auth.check();
      if (options.json) {
        printJson(result);
      } else {
        printLines([
          result.configured ? "AGNES_API_KEY is configured." : "AGNES_API_KEY is missing.",
          `source: ${result.source}`,
          `accounts: ${result.accounts}   pools: ${result.pools.join(", ") || "-"}   strategy: ${result.strategy}`,
        ]);
      }
      if (!result.configured) {
        process.exitCode = 1;
      }
    });
  auth
    .command("save-key")
    .description("Persist AGNES_API_KEY into the current shell rc file")
    .requiredOption("--key <value>", "Agnes API key to persist")
    .option("--json", "Output JSON")
    .action(async (options) => {
      const result = await saveKeyToShell(options.key);
      if (options.json) {
        printJson(result);
        return;
      }
      printLines([
        "AGNES_API_KEY saved.",
        `rc file: ${result.rcFile}`,
      ]);
    });

  const media = program.command("media").description("Resolve Agnes media inputs");
  media.addHelpText("after", `
Examples:
  agnes media url ./frame.png
  agnes media url https://example.com/frame.png

Use this group when Agnes requires a public image URL and your source asset is a local file path.
`);
  media
    .command("url")
    .description("Return a public URL for a local file or pass through an existing URL")
    .argument("<file-or-url>", "Local file path or http(s) URL")
    .option("--ttl <ttl>", "Temporary upload TTL (1h, 12h, 24h, 72h)", "1h")
    .option("--json", "Output JSON")
    .action(async (input, options) => {
      const result = await getClient().media.toPublicUrl(input, { ttl: ttlSchema.parse(options.ttl) });
      if (options.json) {
        printJson(result);
        return;
      }
      console.log(result.url);
    });

  const text = program.command("text").description("Run Agnes text workflows");
  text.addHelpText("after", `
Examples:
  agnes text chat --prompt "Reply with exactly pong."
  agnes --account main text chat --prompt "Reply with exactly pong."
  agnes text chat --model agnes-3.0-flash --prompt "Write a TypeScript function"

Use this group for Agnes chat/completions request shapes when you want a minimal one-shot text call through the CLI.
`);
  text
    .command("chat")
    .description("Run a one-shot Agnes chat completion")
    .requiredOption("--prompt <text>", "Prompt text")
    .option("--model <model>", `Agnes text model (default: ${DEFAULT_TEXT_MODEL})`, DEFAULT_TEXT_MODEL)
    .option("--affinity <name>", "Sticky session name: repeat with the same value to keep one account")
    .option("--json", "Output JSON")
    .addHelpText("after", `
Example:
  agnes text chat --prompt "Reply with exactly pong."

Request shape:
  Sends a single-user-message Agnes /chat/completions request with ${DEFAULT_TEXT_MODEL} by default.
  Switch models with --model (agnes-3.0-flash, agnes-2.5-pro, agnes-2.5-pro-beta). agnes-2.0-flash is deprecated.
`)
    .action(async (options) => {
      if (isDeprecatedTextModel(options.model)) {
        console.error(`warning: ${options.model} is deprecated by Agnes. Prefer ${DEFAULT_TEXT_MODEL}.`);
      }
      const result = await getClient().text.complete({
        prompt: options.prompt,
        model: options.model,
        route: getRouteFor(options),
      });
      if (options.json) {
        printJson(result);
        return;
      }
      console.log(result.text);
      printAccountNotice(result);
    });

  const image = program.command("image").description("Generate Agnes images");
  image.addHelpText("after", `
Examples:
  agnes image text2img --prompt "A luminous city at sunrise" --size 2K --ratio 16:9
  agnes image img2img --image ./input.png --prompt "Restyle this frame for a premium campaign"
  agnes image compose --image ./a.png --image ./b.png --prompt "Blend these references"

Use this group for /images/generations request shapes. text2img sends prompt-only payloads. img2img and compose send image URL arrays in extra_body.image.
`);
  image
    .command("text2img")
    .description("Generate an image from text")
    .requiredOption("--prompt <text>", "Prompt text")
    .option("--model <model>", `Agnes image model (default: ${DEFAULT_IMAGE_MODEL})`)
    .option("--size <size>", `Image size tier (${IMAGE_SIZE_TIERS.join(", ")}) or WIDTHxHEIGHT (default: ${DEFAULT_IMAGE_SIZE})`)
    .option("--ratio <ratio>", `Aspect ratio (${IMAGE_RATIOS.join(", ")})`)
    .option("--seed <number>", "Seed (pass-through; undocumented for image models)", parseInteger)
    .option("--affinity <name>", "Sticky session name: repeat with the same value to keep one account")
    .option("--json", "Output JSON")
    .addHelpText("after", `
Example:
  agnes image text2img --prompt "A luminous city at sunrise" --size 2K --ratio 16:9

Request shape:
  Sends prompt-only generation to Agnes /images/generations with ${DEFAULT_IMAGE_MODEL} by default.
  Pass --size as a tier (1K, 2K, 3K, 4K) or an exact legacy size (e.g. 1024x1024).
`)
    .action(async (options) => {
      const result = await getClient().image.generate({
        mode: "text2img",
        prompt: options.prompt,
        model: options.model,
        size: options.size,
        ratio: options.ratio,
        seed: options.seed,
        route: getRouteFor(options),
      });
      if (options.json) {
        printJson(result);
        return;
      }
      console.log(result.url);
      printAccountNotice(result);
    });
  image
    .command("img2img")
    .description("Generate an image from one input image")
    .requiredOption("--image <path-or-url>", "Input image path or URL")
    .requiredOption("--prompt <text>", "Prompt text")
    .option("--model <model>", `Agnes image model (default: ${DEFAULT_IMAGE_MODEL})`)
    .option("--size <size>", `Image size tier (${IMAGE_SIZE_TIERS.join(", ")}) or WIDTHxHEIGHT (default: ${DEFAULT_IMAGE_SIZE})`)
    .option("--ratio <ratio>", `Aspect ratio (${IMAGE_RATIOS.join(", ")})`)
    .option("--seed <number>", "Seed (pass-through; undocumented for image models)", parseInteger)
    .option("--ttl <ttl>", "Temporary upload TTL", "1h")
    .option("--affinity <name>", "Sticky session name: repeat with the same value to keep one account")
    .option("--json", "Output JSON")
    .addHelpText("after", `
Example:
  agnes image img2img --image ./input.png --prompt "Turn this into an editorial travel poster"

Request shape:
  Resolves the local file to a public URL when needed, then sends it as a one-item Agnes image URL array for image-to-image generation.
`)
    .action(async (options) => {
      const result = await getClient().image.generate({
        mode: "img2img",
        image: options.image,
        prompt: options.prompt,
        model: options.model,
        size: options.size,
        ratio: options.ratio,
        seed: options.seed,
        ttl: ttlSchema.parse(options.ttl),
        route: getRouteFor(options),
      });
      if (options.json) {
        printJson(result);
        return;
      }
      console.log(result.url);
      printAccountNotice(result);
    });
  image
    .command("compose")
    .description("Generate an image from multiple input images")
    .requiredOption("--image <path-or-url...>", "Repeatable image path or URL")
    .requiredOption("--prompt <text>", "Prompt text")
    .option("--model <model>", `Agnes image model (default: ${DEFAULT_IMAGE_MODEL})`)
    .option("--size <size>", `Image size tier (${IMAGE_SIZE_TIERS.join(", ")}) or WIDTHxHEIGHT (default: ${DEFAULT_IMAGE_SIZE})`)
    .option("--ratio <ratio>", `Aspect ratio (${IMAGE_RATIOS.join(", ")})`)
    .option("--seed <number>", "Seed (pass-through; undocumented for image models)", parseInteger)
    .option("--ttl <ttl>", "Temporary upload TTL", "1h")
    .option("--affinity <name>", "Sticky session name: repeat with the same value to keep one account")
    .option("--json", "Output JSON")
    .addHelpText("after", `
Example:
  agnes image compose --image ./a.png --image ./b.png --prompt "Blend these references into one campaign frame"

Request shape:
  Resolves each input to a public URL, preserves image order, and sends an Agnes image URL array for multi-image composition.
`)
    .action(async (options) => {
      const images = toArray(options.image);
      const result = await getClient().image.generate({
        mode: "compose",
        images,
        prompt: options.prompt,
        model: options.model,
        size: options.size,
        ratio: options.ratio,
        seed: options.seed,
        ttl: ttlSchema.parse(options.ttl),
        route: getRouteFor(options),
      });
      if (options.json) {
        printJson(result);
        return;
      }
      console.log(result.url);
      printAccountNotice(result);
    });

  const video = program.command("video").description("Generate Agnes videos");
  video.addHelpText("after", `
Examples:
  agnes video text2video --prompt "A cinematic beach scene at sunset" --seconds 5 --size 720P
  agnes video img2video --image ./frame.png --prompt "Add gentle wind and a soft push-in"
  agnes video keyframes --image ./a.png --image ./b.png --prompt "Transition between the frames"
  agnes video multivideo --image ./a.png --image ./b.png --prompt "Use both images as references"
  agnes video get video_123 --model agnes-video-2.5
  agnes video poll video_123 --model agnes-video-2.5

Agnes Video 2.5 (default) is asynchronous: create a task, then poll it with video_id + model_name.
Create→poll affinity keeps the same account (persisted in AGNES_STATE_DIR) so polls never rotate credentials.
Agnes Video v2.0 was retired on 2026-09-25; legacy flags stay available only for explicit --model agnes-video-v2.0 calls.
`);
  const videoDeps = { getClient, getRoute };
  buildVideoGenerateCommand(video, "text2video", "Generate a video from text", async (client, options, route) =>
    client.video.generate({
      mode: "text2video",
      prompt: options.prompt,
      ...videoOptions(options),
      route,
    }),
    false,
    videoDeps,
  );
  buildVideoGenerateCommand(video, "img2video", "Generate a video from one input image", async (client, options, route) =>
    client.video.generate({
      mode: "img2video",
      image: Array.isArray(options.image) ? options.image[0] : options.image,
      prompt: options.prompt,
      ...videoOptions(options),
      ttl: ttlSchema.parse(options.ttl),
      route,
    }),
    "single",
    videoDeps,
  );
  buildVideoGenerateCommand(video, "multivideo", "Generate a video from multiple input images", async (client, options, route) =>
    client.video.generate({
      mode: "multivideo",
      images: toArray(options.image),
      prompt: options.prompt,
      ...videoOptions(options),
      ttl: ttlSchema.parse(options.ttl),
      route,
    }),
    "multi",
    videoDeps,
  );
  buildVideoGenerateCommand(video, "keyframes", "Generate a keyframe video from multiple images", async (client, options, route) =>
    client.video.generate({
      mode: "keyframes",
      images: toArray(options.image),
      prompt: options.prompt,
      ...videoOptions(options),
      ttl: ttlSchema.parse(options.ttl),
      route,
    }),
    "multi",
    videoDeps,
  );

  video
    .command("get")
    .description("Fetch one Agnes video task status")
    .argument("<video-or-task-id>", "Video id returned by Agnes video creation; task ids are accepted for legacy compatibility")
    .option("--model <model>", `Video model used for model_name polling (default: ${DEFAULT_VIDEO_MODEL})`, DEFAULT_VIDEO_MODEL)
    .option("--timeout <seconds>", "Request timeout seconds", parseInteger, 30)
    .option("--json", "Output JSON")
    .addHelpText("after", `
Example:
  agnes video get video_123 --model agnes-video-2.5

Request shape:
  Sends one GET /agnesapi?video_id={video_id}&model_name={model} request. It does not poll.
  The owning account is resolved from the affinity journal (or --account) so status lookups never rotate credentials.
`)
    .action(async (id, options) => {
      const result = await getClient().video.get(id, {
        timeoutMs: (options.timeout ?? 30) * 1000,
        modelName: options.model,
        route: getRoute(),
      });
      if (options.json) {
        printJson(result);
        return;
      }
      printVideoResult(result);
      printAccountNotice(result);
    });

  video
    .command("poll")
    .description("Poll an Agnes video task until it finishes")
    .argument("<video-or-task-id>", "Video id returned by Agnes video creation; task ids are accepted for legacy compatibility")
    .option("--model <model>", `Video model used for model_name polling (default: ${DEFAULT_VIDEO_MODEL})`, DEFAULT_VIDEO_MODEL)
    .option("--interval <seconds>", "Polling interval seconds", parseInteger, 5)
    .option("--timeout <seconds>", "Polling timeout seconds", parseInteger, 600)
    .option("--json", "Output JSON")
    .addHelpText("after", `
Example:
  agnes video poll video_123 --model agnes-video-2.5 --interval 2 --timeout 600

Request shape:
  Polls GET /agnesapi?video_id={video_id}&model_name={model} until the task completes, fails, or times out.
  model_name is required by Agnes Video 2.5 for keyframe and reference tasks. If you pass a task_ id, the legacy /videos/{task_id} endpoint is used instead.
  Polls always reuse the account that created the task (affinity journal); they never rotate accounts.
`)
    .action(async (id, options) => {
      const result = await getClient().video.poll(id, {
        intervalSeconds: options.interval,
        timeoutSeconds: options.timeout,
        modelName: options.model,
        route: getRoute(),
      });
      if (options.json) {
        printJson(result);
        return;
      }
      printVideoResult(result);
      printAccountNotice(result);
    });

  try {
    await program.parseAsync(argv);
  } catch (error) {
    handleCliError(error, argv);
  }
}

interface VideoCommandDeps {
  getClient: () => AgnesClient;
  getRoute: () => RouteOptions;
}

function buildVideoGenerateCommand(
  video: Command,
  name: string,
  description: string,
  fn: (
    client: AgnesClient,
    options: any,
    route: RouteOptions,
  ) => Promise<unknown>,
  imageMode: false | "single" | "multi" = false,
  deps: VideoCommandDeps,
): void {
  let command = video
    .command(name)
    .description(description)
    .requiredOption("--prompt <text>", "Prompt text")
    .option("--model <model>", `Video model (default: ${DEFAULT_VIDEO_MODEL})`, DEFAULT_VIDEO_MODEL)
    // Agnes Video 2.5 controls
    .option("--seconds <number>", "Video 2.5 duration in seconds (4-12, default 5)", parseInteger)
    .option("--size <tier>", `Video 2.5 resolution tier (${VIDEO_SIZE_TIERS.join(", ")})`)
    .option("--aspect-ratio <ratio>", `Video 2.5 aspect ratio (${VIDEO_ASPECT_RATIOS.join(", ")})`)
    .option("--n <number>", "Video 2.5 output count (only 1 is supported)", parseInteger)
    .option("--seed <number>", "Seed (pass-through; undocumented for image models)", parseInteger)
    // Legacy v2.0 controls
    .option("--width <number>", "Legacy v2.0 only: video width", parseInteger)
    .option("--height <number>", "Legacy v2.0 only: video height", parseInteger)
    .option("--num-frames <number>", "Legacy v2.0 only: frame count (8n + 1, <= 441)", parseInteger)
    .option("--frame-rate <number>", "Legacy v2.0 only: frame rate (1-60)", parseInteger)
    .option("--negative-prompt <text>", "Legacy v2.0 only: negative prompt")
    .option("--affinity <name>", "Sticky session name: repeat with the same value to keep one account")
    .option("--json", "Output JSON");
  if (imageMode === "single") {
    command = command
      .requiredOption("--image <path-or-url>", "Input image path or URL")
      .option("--ttl <ttl>", "Temporary upload TTL", "1h");
  } else if (imageMode === "multi") {
    command = command
      .requiredOption("--image <path-or-url...>", "Repeatable image path or URL")
      .option("--ttl <ttl>", "Temporary upload TTL", "1h");
  }
  command.addHelpText("after", buildVideoHelp(name, imageMode));
  command.action(async (options) => {
    const globals = options as { affinity?: string };
    const route: RouteOptions = { ...deps.getRoute() };
    if (typeof globals.affinity === "string" && globals.affinity.trim()) {
      route.affinityKey = `session:${globals.affinity.trim()}`;
    }
    const client = deps.getClient();
    const result = await fn(client, options, route);
    if (options.json) {
      printJson(result);
      return;
    }
    const task = result as { taskId: string; videoId?: string; status: string; model?: string; accountId?: string };
    const model = task.model ?? options.model;
    const pollId = task.videoId ?? task.taskId;
    printLines([
      `taskId: ${task.taskId}`,
      task.videoId ? `videoId: ${task.videoId}` : undefined,
      `model: ${model}`,
      `status: ${task.status}`,
      `next: agnes video poll ${pollId} --model ${model}`,
    ]);
    const resolved = client.resolvedConfig;
    if (resolved.accountsConfig.accounts.length > 1 && task.accountId) {
      console.error(`account: ${task.accountId}`);
    }
  });
}

function videoOptions(options: any): Record<string, unknown> {
  return {
    model: options.model,
    seconds: options.seconds,
    size: options.size,
    aspectRatio: options.aspectRatio,
    n: options.n,
    seed: options.seed,
    width: options.width,
    height: options.height,
    numFrames: options.numFrames,
    frameRate: options.frameRate,
    negativePrompt: options.negativePrompt,
  };
}

function parseStrategyFlag(value: string): RoutingStrategy {
  const normalized = String(value).trim().toLowerCase();
  if (!(ROUTING_STRATEGIES as readonly string[]).includes(normalized)) {
    throw new AgnesCliError(
      "INVALID_STRATEGY",
      `Unknown routing strategy "${value}". Allowed: ${ROUTING_STRATEGIES.join(", ")}.`,
      undefined,
      2,
    );
  }
  return normalized as RoutingStrategy;
}

function handleCliError(error: unknown, argv: string[]): never {
  const wantsJson = argv.includes("--json");
  if (isAgnesCliError(error)) {
    if (wantsJson) {
      printJson({
        ok: false,
        code: error.code,
        message: error.message,
        ...toJsonDetails(error.details),
      });
      process.exit(error.exitCode);
    }
    console.error(error.message);
    process.exit(error.exitCode);
  }
  if (error instanceof z.ZodError) {
    if (wantsJson) {
      printJson({
        ok: false,
        code: "INVALID_ARGUMENTS",
        message: error.issues.map((issue) => issue.message).join("\n"),
      });
      process.exit(1);
    }
    console.error(error.issues.map((issue) => issue.message).join("\n"));
    process.exit(1);
  }
  if (wantsJson) {
    printJson({
      ok: false,
      code: "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

const ttlSchema = z.enum(["1h", "12h", "24h", "72h"]);

function toJsonDetails(details: unknown): Record<string, unknown> {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }
  return details as Record<string, unknown>;
}

function formatModels(models: ReadonlyArray<{ id: string; status: string }>, defaultId: string): string {
  return models
    .map((model) => {
      const flags = [
        model.id === defaultId ? "default" : undefined,
        model.status !== "current" ? model.status : undefined,
      ].filter(Boolean);
      return flags.length > 0 ? `${model.id} (${flags.join(", ")})` : model.id;
    })
    .join(", ");
}

function printVideoResult(result: {
  videoUrl?: string;
  status: string;
  seconds?: number;
  size?: string;
  model?: string;
}): void {
  printLines([
    result.videoUrl ? result.videoUrl : undefined,
    `status: ${result.status}`,
    result.model ? `model: ${result.model}` : undefined,
    result.seconds !== undefined ? `seconds: ${result.seconds}` : undefined,
    result.size ? `size: ${result.size}` : undefined,
  ]);
}

function buildVideoHelp(name: string, imageMode: false | "single" | "multi"): string {
  const examples: Record<string, string> = {
    text2video: 'agnes video text2video --prompt "A cinematic beach scene at sunset" --seconds 5 --size 720P',
    img2video: 'agnes video img2video --image ./frame.png --prompt "Add gentle wind and a soft push-in"',
    multivideo: 'agnes video multivideo --image ./a.png --image ./b.png --prompt "Use both images as references"',
    keyframes: 'agnes video keyframes --image ./a.png --image ./b.png --prompt "Transition between these frames"',
  };
  const shapeNotes: Record<string, string> = {
    text2video: "Sends `mode: \"text\"` to POST /v1/videos.",
    img2video: "Resolves the input file to a public URL and sends it as `first_frame` in `keyframe` mode.",
    multivideo: "Resolves each input to a public URL and sends them in the top-level `images` array in `reference` mode.",
    keyframes: "Sends the first image as `first_frame` and the second as `last_frame` in `keyframe` mode.",
  };
  const imageNote =
    imageMode === "multi"
      ? "Required image input: repeat --image two or more times. Video 2.5 keyframe mode accepts exactly two; use this command with two keyframes, or multivideo for references."
      : imageMode === "single"
        ? "Required image input: provide exactly one --image."
        : "No image input is required for this mode.";
  return `
Example:
  ${examples[name] ?? `agnes video ${name} --help`}

Request shape:
  ${shapeNotes[name] ?? "Creates an Agnes video task."}
  ${imageNote}
  Video 2.5 by default (${DEFAULT_VIDEO_MODEL}). The retired v2.0 payload is only used with --model agnes-video-v2.0.
  The creating account is journaled for create→poll affinity; polls reuse it.
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runCli(process.argv);
}
