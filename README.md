# Agnes Toolkit

把本机散落的 Agnes 相关 skill、CLI 与脚本收敛成一个可维护、可复用的仓库。

- 上游 CLI：`jomeswang/agnes-ai-cli` v0.1.6（npm latest，GitHub tag 与 HEAD 一致，**没有更新的官方生成 CLI**）
- 上游 skill：`jomeswang/agnes-ai-skill` v1.2.2
- 问题：上游工具默认模型仍是 `agnes-2.0-flash` / `agnes-image-2.1-flash` / `agnes-video-v2.0`，而官方文档（2026-10）已经更新到 2.5 / 3.0 系列，且 **Video v2.0 已于 2026-09-25 下线**。本地旧 CLI 的视频能力实际不可用，图片模型白名单也滞后。
- 处理：将上游源码 vendor 到 `cli/`，按官方文档打补丁（模型、默认值、Video 2.5 API、`model_name` 轮询），重写项目内 skill，并补齐安装/体检/同步/测试脚本。
- 本地补丁版 CLI 版本：`0.3.0-local.1`。2026-10 新增**多账号路由（账号池 / 429 冷却 / create→poll 亲和）**与**批量生产（`agnes batch`）**，详见
  [多账号与批量生产](#多账号与批量生产2026-10)。

> 结论：官网 / GitHub / npm 没有比 0.1.6 更新的官方生成 CLI；但官方 2026-09-24 发布了更新的
> agent skill（`AgnesAI-Labs/skills`），本仓库已一并收录。本地工具按官方文档修复。

## 当前模型（2026-10-21 校验）

| 类别 | 默认模型 | 可选 / 状态 | 文档 |
| --- | --- | --- | --- |
| Text | `agnes-2.5-flash` | `agnes-3.0-flash`、`agnes-2.5-pro`、`agnes-2.5-pro-beta`；`agnes-2.0-flash` 已弃用（实测 HTTP 500） | https://wiki.agnes-ai.com/en/docs/agnes-25-flash |
| Image | `agnes-image-2.5-flash` | `agnes-image-2.1-flash`、`agnes-image-2.0-flash`；size 支持 `1K/2K/3K/4K` 或精确尺寸 | https://wiki.agnes-ai.com/en/docs/agnes-image-25-flash |
| Video | `agnes-video-2.5` | `agnes-video-2.5-flash`；`agnes-video-v2.0` 已于 2026-09-25 下线（仅保留显式 legacy 调用） | https://wiki.agnes-ai.com/en/docs/agnes-video-25 |

文档总索引：https://wiki.agnes-ai.com/llms.txt

## 目录结构

```text
agnes-toolkit/
├── cli/                     # vendor 的上游 agnes-ai-cli 源码 + 本地补丁（可直接 npm link）
│   ├── src/models.ts        # 模型目录 / 默认值（单一事实来源）
│   ├── src/...              # text / image / video / media / auth / CLI
│   ├── test/                # 209 项离线测试（多账号/批量测试不联网）
│   ├── src/accounts/        # 多账号配置、限速、亲和 journal、路由器
│   ├── src/batch/           # batch run/status/retry、manifest/resume
│   ├── UPSTREAM.md          # 上游 commit / 版本记录
│   └── README.md            # 补丁后 CLI 完整参考（英文）
├── skill/
│   ├── agnes-ai-skill/      # CLI-first skill（本仓库 patch 后的 CLI 工作流）
│   └── agnes-ai-models/     # 官方 AgnesAI-Labs skill（2026-09-24 快照，原样收录）
├── scripts/                 # setup / install-local / doctor / sync-upstream / smoke
├── tests/                   # 仓库级离线一致性测试（npm test）
├── docs/                    # 上游调研、本地审计、多账号调研/设计、验证报告
├── .env.example             # 环境变量模板
├── .env.local               # 本地 API key（gitignored，禁止提交）
└── package.json             # 一键命令入口
```

## 快速开始

```bash
cd /Users/mac/Documents/research/agnes
npm run setup            # 安装依赖 + 构建 CLI；缺 .env.local 时从 .env.example 创建
# 把 AGNES_API_KEY 填进 .env.local（权限 600，永不提交）
npm test                 # 离线测试（209 项 CLI 测试 + 仓库一致性检查）
npm run install-local    # 把补丁版 CLI 链接到 PATH，并安装/修复 skill 软链
agnes models             # 查看当前模型目录
agnes auth check         # 校验 key（不打印 key）
agnes accounts check     # 多账号池配置校验（单账号也可用，不发请求）
```

当前机器已经存在 key，`.env.local` 已由本仓库生成；安装脚本会把旧的全局
`agnes-ai-cli@0.1.6` 备份后再 `npm link` 到本项目构建，可随时用
`npm run uninstall-local` 回退。

### 本地 agent 环境同步

`npm run install-local` 除了安装 CLI 和 `~/.agents/skills/`，还会把两个 skill **直接链入本机已存在、且已有 Agnes 条目的 agent 技能目录**，让 Claude Code、devin、crush、goose、junie、mux、qwen、openhands、pochi、trae-cn、codemaker 等环境统一使用本仓库版本（旧的 `agnes-ai-generation` 链接保持可用）：

```bash
npm run install-local                              # 默认同步检测到的 11 个 agent 目录
AGNES_AGENT_SKILL_DIRS=all npm run install-local   # 连 ~/.codex、~/.cursor、~/.gemini 也装
AGNES_AGENT_SKILL_DIRS=/path/a:/path/b npm run install-local  # 自定义目录
npm run doctor                                     # 逐目录检查链接健康
```

安装状态记录在 `~/.agnes-toolkit/install-manifest.env`（v2，兼容 v1）；
`npm run uninstall-local` 会按记录回滚，并恢复安装前的全局包/skill 备份。

### 在其他机器 / 其他 agent 里安装技能

skill 在仓库内（`skill/agnes-ai-skill`、`skill/agnes-ai-models`），可直接从 GitHub 安装：

```bash
# 项目级安装两个 skill（在当前项目生成 .agents/skills + skills-lock.json）
npx skills add ikeng/agnes -s '*' -y

# 只装 CLI-first skill；加 -g 则安装到用户级
npx skills add ikeng/agnes -s agnes-ai-skill -y
npx skills add ikeng/agnes -g -s '*' -y
```

`skills` CLI 会自动递归发现仓库里的两个 skill（实测输出 `Found 2 skills`）。
本机已经用 `npm run install-local` 安装并软链到 `~/.agents/skills/`，无需重复执行。

## 常用命令

```bash
# 文本
agnes text chat --prompt "say pong"
agnes text chat --model agnes-3.0-flash --prompt "写一个 TypeScript 函数"

# 图片（默认 Image 2.5；size 推荐 1K/2K/3K/4K，ratio 推荐 16:9 等）
agnes image text2img --prompt "premium perfume product photo" --size 2K --ratio 16:9
agnes image img2img --image ./input.png --prompt "改成编辑大片风格"
agnes image compose --image ./a.png --image ./b.png --prompt "融合两张参考图"

# 视频（Video 2.5 异步：创建任务 -> poll）
agnes video text2video --prompt "海浪日落航拍" --seconds 5 --size 720P
agnes video img2video --image ./frame.png --prompt "轻微风吹，镜头缓慢推进"
agnes video multivideo --image ./a.png --image ./b.png --prompt "两张参考图融合"
agnes video keyframes --image ./a.png --image ./b.png --prompt "首尾帧过渡"
agnes video get video_xxx --model agnes-video-2.5
agnes video poll video_xxx --model agnes-video-2.5

# 本地文件转公网临时 URL（图生图/视频输入）
agnes media url ./local.png
```

Video 2.5 注意点：

- `--seconds` 4–12（默认 5）；`--size` 为 `720P/1080P/1K/2K`；`--aspect-ratio` 为 `21:9/16:9/4:3/1:1/3:4/9:16`。
- `img2video` 映射到 `keyframe` + `first_frame`；`multivideo` 映射到 `reference` + `images`；`keyframes` 使用首尾两帧（2.5 只支持两张）。
- `agnes-video-2.5-flash` 仅支持 `720P`，最多 5 张参考图。
- 轮询必须带 `--model`（`video_id + model_name`）；`task_` 开头的旧 id 仍走 legacy 端点。
- 视频创建成功后会自动记录 create→poll 亲和（见下文“多账号与批量生产”）；多账号时轮询会自动回到创建账号，不需要手动 `--account`。
- 旧的 `--width/--height/--num-frames/--frame-rate/--negative-prompt` 仅在使用 `--model agnes-video-v2.0` 时可用。

## 多账号与批量生产（2026-10）

> 证据与设计契约：`docs/multi-account-research.md`（官方限速 / 429 / 账号上下文实测）与
> `docs/multi-account-design.md`（§2 配置、§3 路由限速、§5 accounts、§6 batch、§7 安全）。
> 所有命令均可用 `--help` 查看当前构建的真实参数。

### 为什么需要账号池

Agnes 的 RPM / 额度按 **key 类型**共享，不是按每把 key 独立计算：

- **同账号、同类型的多把 key 不会叠加**配额，仍是同一个限速池；只有**不同账号**或**不同 key 类型**
  （`free` / `enterprise` / `tokenplan`）才是相互独立的池。
- 429 是**账号池级别**的拒绝（“rate limit for free users”），所以客户端按 pool 冷却，而不是只换 key。
- 因此多账号不是“多贴几把同类型 key”，而是把**独立池**分组配置；分组用 `POOL` 表示：`pool=` 相同即视为同一个限速池。
  同一账号的多把同类型 key 必须放进同一个 pool，否则客户端会按多个独立池错误限速。
- 默认多账号策略是 `adaptive`；`--account` 强制单账号（禁用 failover），`--strategy` 临时覆盖策略。

### 配置方式（索引环境变量 / accounts 文件）

索引环境变量（key 只放在 `.env.local`，权限 600）：

```ini
# 账号顺序；省略时按 id 排序
AGNES_ACCOUNTS=main,backup

AGNES_ACCOUNT_MAIN_KEY=sk-your-key
AGNES_ACCOUNT_MAIN_TYPE=free              # free | enterprise | tokenplan（默认 free）
AGNES_ACCOUNT_MAIN_POOL=acct-main         # 默认等于账号 id；同账号同类型 key 必须同 pool
AGNES_ACCOUNT_MAIN_WEIGHT=1               # weighted 策略权重
AGNES_ACCOUNT_MAIN_PRIORITY=0             # primary 策略优先级，越小越优先
# AGNES_ACCOUNT_MAIN_CONCURRENCY=2        # 覆盖该账号并发上限；默认按类型预设
# AGNES_ACCOUNT_MAIN_MODELS=agnes-image-2.5-flash,agnes-video-2.5   # 可选模型白名单
# AGNES_ACCOUNT_MAIN_BASE_URL=https://apihub.agnes-ai.com/v1         # 可选独立网关
# AGNES_ACCOUNT_MAIN_LABEL=main-free

AGNES_ACCOUNT_BACKUP_KEY=sk-your-key
AGNES_ACCOUNT_BACKUP_TYPE=tokenplan
AGNES_ACCOUNT_BACKUP_POOL=acct-backup

AGNES_ROUTING_STRATEGY=adaptive           # adaptive | round-robin | weighted | least-inflight | primary
AGNES_RATE_LIMIT=on                       # on | off（客户端限速，默认 on）
AGNES_STATE_DIR=~/.agnes/state            # 亲和 journal 目录（0700）
```

账号文件（适合账号多、或不想把 key 放 env；路径必须显式指定，不会自动搜索）：

```json
{
  "version": 1,
  "strategy": "adaptive",
  "rateLimit": true,
  "accounts": [
    { "id": "main", "keyEnv": "AGNES_ACCOUNT_MAIN_KEY", "type": "free", "pool": "acct-main", "label": "main free" },
    { "id": "backup", "key": "sk-your-key", "type": "tokenplan", "pool": "acct-backup", "weight": 2 }
  ]
}
```

```bash
export AGNES_ACCOUNTS_FILE=/absolute/path/accounts.json   # 文件权限建议 600
```

- 优先级：显式 JS API options > accounts 文件 > 索引环境变量 > 单个 `AGNES_API_KEY`。
- 文件含未知字段、缺 key、同一 pool 混用 key 类型等会报 `INVALID_ACCOUNTS_CONFIG` 并以退出码 2 结束。
- 文件可读权限过宽时会在 stderr 警告；`AGNES_ACCOUNTS_ALLOW_INSECURE=1` 可静默（不建议）。
- **单个 `AGNES_API_KEY` 仍然完全可用**：等价于一个 `id=default`、类型 `free` 的账号，行为与 0.2.x 一致。

### 查询与体检

```bash
agnes accounts list                     # 脱敏列表：只显示 present (len=N) / missing，绝不打印 key
agnes accounts list --json
agnes accounts check                    # 只校验配置，不发请求；缺账号时退出 1
agnes accounts check --live             # 默认 --probe models：GET {baseUrl}/models，只证明“可达”
agnes accounts check --live --probe text  # 真正的凭证验证：每个账号 1 次 max_tokens:1 文本请求
```

- `--live` 默认使用 `--probe models`（最多 2 个在途请求），输出 `reachable` / `httpStatus` /
  `modelCount` / `missingConfiguredModels`，不产生图片/视频生成费用。**但它不是凭证验证**：
  当前网关对伪造 token 的 `GET /v1/models` 也返回 200（2026-10-23 实测），CLI 会在 stderr 与
  `warnings[]` 明确提示这一点。
- `--probe text` 是唯一能证明“这把 key 有效”的路径：每个账号发送恰好一次最小对话请求
  （`max_tokens:1`，30s 超时，并发 2，不重试），2xx 才记为 `credentialValidated:true`；
  任一账号失败退出 1。费用仅为每账号一次极小的文本请求，不会生成图片/视频。
- 显式指定 `--probe <models|text>` 会隐含 `--live`；非法值以退出码 2 报 `INVALID_PROBE`
  （带 `--json` 时输出 JSON）。
- 多个账号都未显式设置 `pool=` 时，`accounts list` 会给出分组警告。
- `agnes auth check --json` 在单账号/多账号下都会额外给出 `accounts` / `pools` / `strategy`。

### 路由、限速与 429

路由策略（全局 `--strategy <name>` 可临时覆盖，也可用 `AGNES_ROUTING_STRATEGY`）：

| 策略 | 行为 |
| --- | --- |
| `adaptive` | 默认（多账号）；按“当前 in-flight / 并发上限”选最空闲账号，同分时轮转 |
| `round-robin` | 按配置顺序轮转 |
| `weighted` | 平滑加权轮询，权重取 `WEIGHT` |
| `least-inflight` | 取 in-flight 绝对值最低的账号 |
| `primary` | 按 `PRIORITY` 升序，相同则按配置顺序（单账号默认策略） |

客户端限速预设（RPM，来自官方 tokenplan 文档；账号类型决定，`CONCURRENCY` 可覆盖并发）：

| 负载 | free | enterprise | tokenplan |
| --- | ---: | ---: | ---: |
| text | 10 | 20 | 1000 |
| image 1K | 10 | 40 | 100 |
| image 2K | 5 | 20 | 80 |
| image 3K / 4K | 1 / 1 | 1 / 1 | 1 / 1 |
| video（create） | 1 | 2 | 5 |

- 每个 pool 一个令牌桶（容量 = max(1, RPM)，每毫秒回填 RPM/60000 个令牌）；状态轮询每 pool 最多 1 个在途，
  自适应间隔从 2s 起、429 翻倍、每 20 次成功 ×0.9，范围 1s–30s。
- **429 / Retry-After**：能读到 `Retry-After`（数字秒或 HTTP date）就用它，否则指数退避
  1s→2s→4s…+抖动，上限 30s；冷却的是整个 pool。创建请求的 429 属于“执行前拒绝”，可立即切换
  另一个可用 pool（在 `AGNES_ROUTING_MAX_ATTEMPTS` 内）；若所有 pool 都在冷却，则在
  `AGNES_ROUTING_MAX_WAIT_MS`（默认 60000）内等待最早恢复的 pool。
- 状态查询（`video get/poll`）**永不换账号**：429 只等待同一账号/池，避免把别人的任务当自己的查。
- 5xx / 网络错误发生在创建 POST 后 → `AMBIGUOUS_CREATE`，**不会自动重试**（任务可能已被受理并计费）；
  先到 Agnes 控制台确认再重试。
- 401/403 → 账号标记不健康后 failover；402 → pool 标记额度耗尽后 failover；403 模型无权限 → 该账号对
  该模型不可用后 failover。400/404/422 原样返回给调用方，不 failover。
- `--account` 强制账号时不做 failover（429 仍受冷却/限速约束），错误信息里会带上账号 id。

### create→poll 亲和与状态目录

- 视频创建成功后自动写入 `video:<videoId>`、`task:<taskId>` 亲和；
  `agnes video get/poll` 解析顺序：显式 `--account` → 亲和 journal → 只有一个账号时直接用 →
  无 journal 时按配置顺序有界探测（最多 `min(3, 账号数)` 个账号，遇 404 继续）。
  全部 404 → `AFFINITY_NOT_FOUND`，并提示用 `--account` 指定所属账号。
- 文本/图片/视频创建命令支持 `--affinity <name>`（映射为 `session:<name>`）：同一 name 的多次调用固定
  同一账号（适合多轮会话/连续编辑）；显式 `--account` 优先，成功后才重新绑定。
- journal 位于 `$AGNES_STATE_DIR/affinity.json`（默认 `~/.agnes/state`）：目录 0700、文件 0600、
  原子写并合并并发进程写入、TTL 7 天、最多 5000 条；**只存账号 id / pool / 模型 / 资源 id，不存 key**。
- 换机器或清空 state 后亲和会丢失：用 `--account <id>` 显式恢复；批量任务内部使用
  `batch:<batchId>:<jobId>` 亲和并可在 resume 时复用。

### 批量生产（`agnes batch`）

输入 JSON（也支持 JSONL：每行一个 job，允许空行与 `#`/`//` 注释）：

```json
{
  "version": 1,
  "batchId": "ui-icons-v1",
  "consistency": "record",
  "defaults": { "ttl": "1h" },
  "defaultsByKind": {
    "image": { "model": "agnes-image-2.5-flash", "size": "1K", "ratio": "1:1" },
    "video": { "model": "agnes-video-2.5", "size": "720P", "seconds": 5 },
    "text": { "model": "agnes-2.5-flash" }
  },
  "jobs": [
    { "id": "icon-001", "kind": "image", "mode": "text2img", "prompt": "a shield icon" },
    { "id": "clip-001", "kind": "video", "mode": "text2video", "prompt": "a wave at dusk" },
    { "id": "copy-001", "kind": "text", "prompt": "say pong" }
  ]
}
```

> 提示：默认值是 **kind-aware** 的。每个参数的优先级为：job 自身 > `defaultsByKind[kind]` >
> flat `defaults`（仅当该 kind 接受此参数）> 该 kind 内置默认值。flat `defaults.model` 只有在属于该 kind
> 的模型目录时才会应用，否则自动回退到 kind 默认（image `agnes-image-2.5-flash` / video
> `agnes-video-2.5` / text `agnes-2.5-flash`）；不兼容参数会被丢弃（图片 `ratio`/精确尺寸不会传给 video，
> `1K` 对 image 与 video 都合法）。每个 job 的 `model` 与 `modelSource`（`job`/`defaults`/`kind-default`）
> 会写入 manifest、`input.json`、`results/<id>.json` 和 `batch status --json`。
> `defaultsByKind` 只允许该 kind 支持的参数，未知 kind/key 或 kind 不兼容参数会报 `INVALID_BATCH_INPUT`（退出 2）。

```bash
agnes batch run jobs.json --out ./out              # 执行
agnes batch run jobs.jsonl --out ./out --concurrency 4 --consistency strict
agnes batch run jobs.json --out ./out --dry-run    # 只校验并打印计划，不发请求、不写文件
agnes batch status ./out                           # 查看进度/每 job 账号与结果 URL
agnes batch retry ./out --only failed              # 重试失败/待处理（failed | pending | all）
agnes batch run jobs.json --out ./out --resume     # 断点续跑：跳过已成功 job，不重复创建
```

- 产物（均在 `--out` 目录，原子写、0600）：`manifest.json`（输入 hash、默认值、每个 job 的模型/来源/
  状态/账号/结果）、`input.json`（规范化后的有效 job，含 model/modelSource；有 `defaultsByKind` 时保留原分区，供 retry/resume）、
  `events.jsonl`（进度事件）、`results/<id>.json`（含 model/modelSource）。
  `manifest.jobs` 始终按输入顺序；`summary.accountsUsed` 排序；跨账号批次 `mixedAccounts=true`。
- 一致性模式：
  - `record`（默认）：每个 job 由路由器选择账号并记录 `accountId/poolId/routing`；视频 job 的 create→poll
    固定同一账号；适合吞吐优先、允许跨账号产出。
  - `strict`：整批固定一个账号（按 priority/策略选出；`--account` 强制并隐含 strict），video 轮询也在该账号；
    429 只等该 pool 冷却，401/402/403 直接失败（无法满足 strict 一致性）；适合需要可比较输出的场景。
- resume/retry 语义：已成功/跳过 job 不会重新创建；输入 hash 变化会中止（`BATCH_INPUT_CHANGED`）；
  上次中断时处于 `running` 的 job 会恢复为 pending 并警告“创建请求可能已被受理”；retry 默认只重跑 failed。
- job 级非法参数（客户端 zod / `INVALID_*` 校验失败）归类为不可重试的 `INVALID_JOB`，消息带 job id，
  不会自动重试（避免重复创建），退出码 `1`；修正参数后用 `batch retry <out> --only failed` 重跑。
- 退出码：`0` 全部成功/跳过；`1` 有 job 失败；`2` 输入/配置错误（含 manifest 缺失/不匹配）。
- 默认 `--concurrency 4`，同时受路由器每账号/每 pool 并发上限约束；`RATE_LIMITED`、GET 网络错误、
  `SERVICE_BUSY`、`POLL_TIMEOUT` 会按 job 级重试（`--max-attempts`，默认 2）；
  `AMBIGUOUS_CREATE` 永不自动重试。

### 输出与安全

- 多账号时，人类可读输出的 stderr 会多一行 `account: <id>` 作为来源提示，**stdout 保持原有格式**；
  单账号不打印。所有 `--json` 结果新增 `accountId`、`poolId`、`routing`（strategy/attempts/waitedMs/fallback）。
- key 只出现在 `.env.local`（600）或显式 accounts 文件（600）；`accounts list/check`、manifest、events、
  错误信息里都只有账号 id 与 `present (len=N)`，绝无 key 值。
- 仓库 `.gitignore` 已排除 `.agnes-accounts.json`、`agnes-accounts.json`、`agnes-batch/`；
  state 目录默认在仓库外（`~/.agnes/state`）。
- 不要因为任务上下文丢失就轮询时换账号：先查亲和/`--account`，确认归属后再继续。
- 完整英文命令/错误码/troubleshooting 参考见 [`cli/README.md`](cli/README.md)。

## 配置（CLI 自动读取 `.env.local`）

CLI 从当前目录向上最多 4 级查找最近的 `.env.local` 并加载（已存在的环境变量优先；
`AGNES_NO_DOTENV=1` 可关闭，`AGNES_ENV_FILE=/path` 可显式指定）。

| 变量 | 作用 |
| --- | --- |
| `AGNES_API_KEY` | 单账号 key（与多账号配置二选一；配了索引账号时被忽略并警告） |
| `AGNES_ACCOUNT_<ID>_KEY` 等 | 多账号池：`_KEY/_TYPE/_POOL/_WEIGHT/_PRIORITY/_CONCURRENCY/_MODELS/_BASE_URL/_LABEL`；同类型 key 不叠加，用 `_POOL` 分组 |
| `AGNES_ACCOUNTS` / `AGNES_ACCOUNTS_FILE` | 账号顺序（可选）/ 账号 JSON 文件显式路径 |
| `AGNES_ROUTING_STRATEGY` | 路由策略：`adaptive`（多账号默认）/`round-robin`/`weighted`/`least-inflight`/`primary` |
| `AGNES_ROUTING_MAX_ATTEMPTS` / `AGNES_ROUTING_MAX_WAIT_MS` | 单请求最大尝试次数（默认 3）/ 最大等待毫秒（默认 60000） |
| `AGNES_RATE_LIMIT` | 客户端限速 `on`/`off`（默认 on） |
| `AGNES_STATE_DIR` | 亲和 journal 目录（默认 `~/.agnes/state`，目录 0700 / 文件 0600） |
| `AGNES_POLL_INTERVAL_MS` / `AGNES_POLL_TIMEOUT_MS` | 状态轮询节流下限（默认 2000ms）/ JS API 与 batch 的轮询预算（默认 600000ms；`agnes video poll` 的 `--timeout` 默认 600s 优先） |
| `AGNES_BASE_URL` | 网关覆盖；中国区 `https://api.agnes-ai.cn/v1`，国际备用 `https://apihub.agnes-ai.cn/v1` |
| `AGNES_MEDIA_PROVIDER_ORDER` | 临时图床顺序；本机默认 `uguu,x0,litterbox,tmpfiles`（Litterbox 在本机被 403/412 拦截） |
| `AGNES_HTTP_TIMEOUT_MS` | 单请求超时，默认 120000 |
| `AGNES_ENV_FILE` / `AGNES_NO_DOTENV` | 指定 env 文件 / 关闭自动加载 |

`agnes auth check` 在 key 缺失时返回退出码 1；状态轮询会对 429/5xx/网络错误自动重试，
创建类 POST 默认不重试，避免重复计费。

## 密钥与安全

- API key 只放在 `.env.local`（权限 600），已在 `.gitignore` 中排除；仓库内不含任何 key。
- 多账号 key 同样只放在 `.env.local` 或显式指定的 accounts 文件（建议 600）；`agnes accounts list/check`
  只显示 `present (len=N)` / `missing`，不会打印 key。
- 亲和 journal / 路由状态在 `AGNES_STATE_DIR`（默认 `~/.agnes/state`）：目录 0700、文件 0600，
  只记录账号 id、pool、模型与资源 id，不含 key。
- batch 产物（manifest/events/results）权限 0600，不含 key；`.gitignore` 已排除
  `.agnes-accounts.json`、`agnes-accounts.json`、`agnes-batch/`。
- `scripts/agnes` 包装器会读取 `.env.local` 后再执行项目 CLI，不会把 key 写入日志。
- `npm test` 包含 secrets 扫描与 shell 语法检查；提交前会再次确认 `.env.local` 未入库。
- 不要把 key 写进 `.env.example`、README、skill 或测试。

## 维护与升级

```bash
npm run doctor           # 版本 / 构建 / key / 网络 / skill 软链体检
npm run sync-upstream    # 对比上游 npm/GitHub 与本地；不会自动覆盖补丁
npm test                 # 仓库一致性测试
```

- 上游差异记录在 `cli/UPSTREAM.md`；本地补丁的完整 diff 在 `patches/`。
- 如果上游发布新版本：先 `npm run sync-upstream` 拉取到 staging，按
  `docs/upstream-research.md` 的 patch 清单重新应用，再跑 `npm test`。
- 模型变更时优先改 `cli/src/models.ts`，然后同步 skill 与测试。

## 文档

- `docs/upstream-research.md`：官方文档 / GitHub / npm 调研与模型契约
- `docs/multi-account-research.md`：多账号限速 / 429 / Video 账号上下文实测证据（2026-10-23）
- `docs/multi-account-design.md`：多账号路由 + 批量生产设计契约（配置、路由限速、accounts、batch、安全）
- `docs/local-audit.md`：本机旧工具问题清单与复现
- `docs/verification.md`：最终独立验证记录

## 许可

`cli/` 目录来自 MIT 许可的 `jomeswang/agnes-ai-cli`，原 LICENSE 已保留；
`skill/` 目录来自 `jomeswang/agnes-ai-skill`，原 LICENSE 已保留。
