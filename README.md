# Agnes Toolkit

把本机散落的 Agnes 相关 skill、CLI 与脚本收敛成一个可维护、可复用的仓库。

- 上游 CLI：`jomeswang/agnes-ai-cli` v0.1.6（npm latest，GitHub tag 与 HEAD 一致，**没有更新的官方生成 CLI**）
- 上游 skill：`jomeswang/agnes-ai-skill` v1.2.2
- 问题：上游工具默认模型仍是 `agnes-2.0-flash` / `agnes-image-2.1-flash` / `agnes-video-v2.0`，而官方文档（2026-10）已经更新到 2.5 / 3.0 系列，且 **Video v2.0 已于 2026-09-25 下线**。本地旧 CLI 的视频能力实际不可用，图片模型白名单也滞后。
- 处理：将上游源码 vendor 到 `cli/`，按官方文档打补丁（模型、默认值、Video 2.5 API、`model_name` 轮询），重写项目内 skill，并补齐安装/体检/同步/测试脚本。

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
│   ├── test/                # 74 项离线测试
│   ├── UPSTREAM.md          # 上游 commit / 版本记录
│   └── README.md            # 补丁后 CLI 使用说明
├── skill/
│   ├── agnes-ai-skill/      # CLI-first skill（本仓库 patch 后的 CLI 工作流）
│   └── agnes-ai-models/     # 官方 AgnesAI-Labs skill（2026-09-24 快照，原样收录）
├── scripts/                 # setup / install-local / doctor / sync-upstream / smoke
├── tests/                   # 仓库级离线一致性测试（npm test）
├── docs/                    # 上游调研、本地审计、验证报告
├── .env.example             # 环境变量模板
├── .env.local               # 本地 API key（gitignored，禁止提交）
└── package.json             # 一键命令入口
```

## 快速开始

```bash
cd /Users/mac/Documents/research/agnes
npm run setup            # 安装依赖 + 构建 CLI；缺 .env.local 时从 .env.example 创建
# 把 AGNES_API_KEY 填进 .env.local（权限 600，永不提交）
npm test                 # 离线测试（74 项 CLI 测试 + 仓库一致性检查）
npm run install-local    # 把补丁版 CLI 链接到 PATH，并安装/修复 skill 软链
agnes models             # 查看当前模型目录
agnes auth check         # 校验 key（不打印 key）
```

当前机器已经存在 key，`.env.local` 已由本仓库生成；安装脚本会把旧的全局
`agnes-ai-cli@0.1.6` 备份后再 `npm link` 到本项目构建，可随时用
`npm run uninstall-local` 回退。

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
- 旧的 `--width/--height/--num-frames/--frame-rate/--negative-prompt` 仅在使用 `--model agnes-video-v2.0` 时可用。

## 配置（CLI 自动读取 `.env.local`）

CLI 从当前目录向上最多 4 级查找最近的 `.env.local` 并加载（已存在的环境变量优先；
`AGNES_NO_DOTENV=1` 可关闭，`AGNES_ENV_FILE=/path` 可显式指定）。

| 变量 | 作用 |
| --- | --- |
| `AGNES_API_KEY` | 必填，API key |
| `AGNES_BASE_URL` | 网关覆盖；中国区 `https://api.agnes-ai.cn/v1`，国际备用 `https://apihub.agnes-ai.cn/v1` |
| `AGNES_MEDIA_PROVIDER_ORDER` | 临时图床顺序；本机默认 `uguu,x0,litterbox,tmpfiles`（Litterbox 在本机被 403/412 拦截） |
| `AGNES_HTTP_TIMEOUT_MS` | 单请求超时，默认 120000 |
| `AGNES_ENV_FILE` / `AGNES_NO_DOTENV` | 指定 env 文件 / 关闭自动加载 |

`agnes auth check` 在 key 缺失时返回退出码 1；状态轮询会对 429/5xx/网络错误自动重试，
创建类 POST 默认不重试，避免重复计费。

## 密钥与安全

- API key 只放在 `.env.local`（权限 600），已在 `.gitignore` 中排除；仓库内不含任何 key。
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
- `docs/local-audit.md`：本机旧工具问题清单与复现
- `docs/verification.md`：最终独立验证记录

## 许可

`cli/` 目录来自 MIT 许可的 `jomeswang/agnes-ai-cli`，原 LICENSE 已保留；
`skill/` 目录来自 `jomeswang/agnes-ai-skill`，原 LICENSE 已保留。
