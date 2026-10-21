// Repo test: model catalog defaults are consistent across the CLI source, the
// built CLI, the project skills, and the README (offline, no API calls).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(TEST_DIR);
const CLI = path.join(ROOT, "cli", "bin", "agnes.js");

let checks = 0;
let failures = 0;
function check(name, fn) {
  checks += 1;
  process.stdout.write(`  - ${name} ... `);
  try {
    const detail = fn();
    process.stdout.write("ok\n");
    if (detail) process.stdout.write(`      ${detail}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write("FAIL\n");
    process.stdout.write(`      ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function read(rel) {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

function arrayConst(source, name) {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`));
  if (!match) throw new Error(`cannot parse ${name} from cli/src/models.ts`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function stringConst(source, name) {
  const match = source.match(new RegExp(`export const ${name} = "([^"]+)";`));
  if (!match) throw new Error(`cannot parse ${name} from cli/src/models.ts`);
  return match[1];
}

function semverParts(version) {
  return String(version)
    .replace(/^v/, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function semverAtLeast(version, min) {
  const a = semverParts(version);
  const b = semverParts(min);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

const modelsSource = read(path.join("cli", "src", "models.ts"));
const models = {
  text: arrayConst(modelsSource, "TEXT_MODELS"),
  image: arrayConst(modelsSource, "IMAGE_MODELS"),
  video: arrayConst(modelsSource, "VIDEO_MODELS"),
  textDefault: stringConst(modelsSource, "DEFAULT_TEXT_MODEL"),
  imageDefault: stringConst(modelsSource, "DEFAULT_IMAGE_MODEL"),
  videoDefault: stringConst(modelsSource, "DEFAULT_VIDEO_MODEL"),
};

check("model defaults are the documented 2.5 generation", () => {
  if (models.textDefault !== "agnes-2.5-flash") throw new Error(`text default ${models.textDefault}`);
  if (models.imageDefault !== "agnes-image-2.5-flash") throw new Error(`image default ${models.imageDefault}`);
  if (models.videoDefault !== "agnes-video-2.5") throw new Error(`video default ${models.videoDefault}`);
  return `${models.textDefault} / ${models.imageDefault} / ${models.videoDefault}`;
});

check("deprecated/retired models stay selectable but not default", () => {
  if (!models.text.includes("agnes-2.0-flash")) throw new Error("agnes-2.0-flash missing from TEXT_MODELS");
  if (!models.video.includes("agnes-video-v2.0")) throw new Error("agnes-video-v2.0 missing from VIDEO_MODELS");
  if (models.textDefault === "agnes-2.0-flash") throw new Error("deprecated text model is the default");
  if (models.videoDefault === "agnes-video-v2.0") throw new Error("retired video model is the default");
  return "2.0 deprecated, v2.0 retired-only";
});

check("built CLI `models --json` matches the source catalog", () => {
  if (!existsSync(CLI)) throw new Error("cli/bin/agnes.js missing (build required)");
  const result = spawnSync(process.execPath, [CLI, "models", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, AGNES_NO_DOTENV: "1" },
  });
  if (result.status !== 0) throw new Error(`models --json exited ${result.status}: ${result.stderr}`);
  const catalog = JSON.parse(result.stdout);
  const ids = (group) => group.models.map((entry) => entry.id).sort();
  if (JSON.stringify(ids(catalog.text)) !== JSON.stringify([...models.text].sort())) throw new Error("text catalogs differ");
  if (JSON.stringify(ids(catalog.image)) !== JSON.stringify([...models.image].sort())) throw new Error("image catalogs differ");
  if (JSON.stringify(ids(catalog.video)) !== JSON.stringify([...models.video].sort())) throw new Error("video catalogs differ");
  if (catalog.text.default !== models.textDefault) throw new Error("text default differs in built CLI");
  if (catalog.image.default !== models.imageDefault) throw new Error("image default differs in built CLI");
  if (catalog.video.default !== models.videoDefault) throw new Error("video default differs in built CLI");
  const text20 = catalog.text.models.find((entry) => entry.id === "agnes-2.0-flash");
  const video20 = catalog.video.models.find((entry) => entry.id === "agnes-video-v2.0");
  if (!text20 || text20.status !== "deprecated") throw new Error("agnes-2.0-flash is not marked deprecated");
  if (!video20 || video20.status !== "retired") throw new Error("agnes-video-v2.0 is not marked retired");
  return "source == built CLI";
});

check("CLI-first skill (v1.3.0) references the current defaults", () => {
  const skillPath = path.join("skill", "agnes-ai-skill", "SKILL.md");
  if (!existsSync(path.join(ROOT, skillPath))) throw new Error("missing skill/agnes-ai-skill/SKILL.md");
  const skill = read(skillPath);
  const versionMatch = skill.match(/^version:\s*(.+)$/m);
  const version = versionMatch ? versionMatch[1].trim() : "0.0.0";
  if (!semverAtLeast(version, "1.3.0")) return `skipped model-claim checks: skill version ${version} < 1.3.0`;
  for (const [kind, id] of Object.entries({
    text: models.textDefault,
    image: models.imageDefault,
    video: models.videoDefault,
  })) {
    if (!skill.includes(id)) throw new Error(`${kind} default ${id} not mentioned in SKILL.md`);
  }
  if (!skill.includes("agnes models")) throw new Error("SKILL.md does not mention `agnes models`");
  if (!skill.includes("wiki.agnes-ai.com")) throw new Error("SKILL.md lacks current docs links");
  if (/current default[^\n]{0,40}agnes-video-v2\.0/i.test(skill)) throw new Error("SKILL.md still calls v2.0 the current video default");
  if (/default when[^\n]{0,80}agnes-2\.0-flash/i.test(skill)) throw new Error("SKILL.md still calls 2.0-flash the default");
  return `skill v${version} consistent`;
});

check("vendored official skill is present and mentions the current family", () => {
  const skillPath = path.join(ROOT, "skill", "agnes-ai-models", "SKILL.md");
  if (!existsSync(skillPath)) throw new Error("missing skill/agnes-ai-models/SKILL.md");
  const skill = readFileSync(skillPath, "utf8");
  const mentionsCurrent = ["agnes-image-2.5-flash", "agnes-video-2.5", "agnes-2.5-flash"].filter((id) => skill.includes(id));
  if (mentionsCurrent.length === 0) throw new Error("official skill does not mention any current model ID");
  return `mentions ${mentionsCurrent.join(", ")}`;
});

check("root README documents the same defaults", () => {
  const readme = read("README.md");
  for (const id of [models.textDefault, models.imageDefault, models.videoDefault]) {
    if (!readme.includes(id)) throw new Error(`README.md missing ${id}`);
  }
  return "README defaults match cli/src/models.ts";
});

check("no removed/retired model presented as an active default in CLI source", () => {
  if (/DEFAULT_TEXT_MODEL\s*=\s*"agnes-2\.0-flash"/.test(modelsSource)) throw new Error("2.0-flash default");
  if (/DEFAULT_VIDEO_MODEL\s*=\s*"agnes-video-v2\.0"/.test(modelsSource)) throw new Error("v2.0 default");
  if (models.video.includes("agnes-video-v2.0") && !/RETIRED_VIDEO_MODELS/.test(modelsSource)) {
    throw new Error("v2.0 present without RETIRED_VIDEO_MODELS marker");
  }
  return "no retired defaults";
});

console.log(`  => ${checks} checks, ${failures} failure(s)`);
if (failures > 0) process.exit(1);
