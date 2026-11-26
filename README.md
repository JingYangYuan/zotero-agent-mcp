# Zotero-Agent-MCP

让本地 AI agent（任何支持 MCP 的客户端或任意脚本）**快速、安全地读写 Zotero** 的插件。
在 Zotero 内置 HTTP 服务（`127.0.0.1:23119`）上注册 `/zotero-agent-mcp/` API，并提供**零依赖 MCP 桥（34 个工具）**与**内置 agent 路由 skill**。
插件在进程内直调 Zotero 内部 API，**能力是 Zotero 本地 API 的超集**——agent 无需再绕行 `/api/**`。

> **v0.6.2 重点**：自动覆盖 **20 种常见 AI agent 客户端**（合并写入、自动备份、可撤销、启动时自动同步令牌）；「接入 agent」内建显眼的手动接入复制与预览卡片；移除本地限流；`tools/list` 上下文成本 58.8%；配置默认本地 node 直启（握手 ~25ms）。

## 三步开始

1. **装插件**：`tools/build.sh` 构建 → Zotero → 工具 → 插件 → 齿轮 → *Install Plugin From File…* → 选 `build/zotero-agent-mcp.xpi`。
2. **看设置**：Zotero → 设置 → **Zotero-Agent-MCP**。状态条确认「运行中」，令牌默认掩码显示。
3. **接 agent**：装好插件后**自动完成**——启动时会把 `zotero-agent` 写入所有已安装客户端的配置，令牌变化后自动同步。
   面板逐行显示 `已接入 / 未接入 / 未安装 / 令牌过期`，每行可 [更新] / [撤销]；点 **连接测试** 会用 node 真启一次桥接并回读 `/ping`。

## 设置面板

| 区块 | 内容 |
|---|---|
| 状态条 | 版本 · 运行状态 · 实际 `baseUrl`（跟随 Zotero 端口） |
| 服务 | 启用开关 · 访问令牌（显示/复制/重新生成，重新生成需确认） |
| 接入 agent | 20 个客户端逐行状态（已安装优先置顶）+ [接入]/[更新]/[撤销] · 全部接入 · 连接测试 · 自动同步开关 · 安装/撤销 skill · 未覆盖客户端手动接入卡片（复制 `node`/`npx` 配置与展开预览） |
| 高级设置（折叠） | 六个功能作用域（中文标签）· 库白名单 · 审计日志 + 查看 · 桥接目录 · 通用 curl 复制 |

写入是**合并式**的：只增改 `zotero-agent` 这一条，其它条目与原有格式原样保留；首次改动前生成 `<配置文件>.zotero-agent-mcp.bak` 备份；高级里可「撤销全部接入」。

## 客户端支持（20 个）

| 客户端 | 配置位置 | 写入格式 |
|---|---|---|
| Claude Code | `~/.claude.json` | `mcpServers` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json`（Win: `%APPDATA%\Claude\…`） | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.zotero-agent]` TOML |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers`（默认 npx 变体） |
| Antigravity | `~/.gemini/config/mcp_config.json` / `~/.gemini/antigravity/mcp_config.json` | `mcpServers` |
| WorkBuddy | `~/.workbuddy/mcp.json` | `mcpServers` |
| GitHub Copilot CLI | `~/.copilot/mcp-config.json` | `mcpServers` |
| Factory (Droid) | `~/.factory/mcp.json` | `mcpServers` |
| Kimi Code | `~/.kimi-code/mcp.json` / `~/.kimi/mcp.json` | `mcpServers` |
| Oh-My-Pi (OMP) | `~/.omp/agent/mcp.json` | `mcpServers` |
| CommandCode | `~/.commandcode/mcp.json` | `mcpServers` |
| Amp | `~/.config/amp/settings.json`（Win 兼容 `%APPDATA%\amp\settings.json`） | `amp.mcpServers` |
| ZCode | `~/.zcode/cli/config.json` | `mcp.servers` |
| VS Code | `~/Library/Application Support/Code/User/mcp.json` 或 `.vscode/mcp.json` | `servers` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp`（`type: local`） |
| Pi agent | `~/.pi/agent/mcp.json` | `mcpServers` |
| Trae | `%APPDATA%\Trae\User\mcp.json` / `Trae CN` / `~/.trae/mcp.json` | `mcpServers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Kiro | `~/.kiro/settings/mcp.json` | `mcpServers` |

想加自己的客户端：在 `<Zotero 数据目录>/zotero-agent-mcp/clients.local.json` 里按 `clients.json` 的结构追加/覆盖（按 `id` 合并），面板会自动按新注册表写入。

`~/Zotero/zotero-agent-mcp/agent-configs.json` 里有全部客户端的 node / npx 两种配置片段，供脚本或手动粘贴使用。

## 两种启动方式

| 方式 | 命令 | 适用 |
|---|---|---|
| 本地 node 直启（默认） | `"/usr/local/bin/node" "<数据目录>/zotero-agent-mcp/zotero-agent-mcp.mjs"` | 所有能访问文件系统的客户端，握手 ~25ms |
| npx | `npx --prefer-offline -y zotero-agent-mcp --token <令牌>` | 沙盒客户端（如 Gemini App）、不想暴露文件路径时；命中缓存 ~0.5s |

令牌也可由桥自动读取 `~/Zotero/zotero-agent-mcp/token`，但显式 `env.ZOTERO_AGENT_TOKEN` 更稳。

### 直接 HTTP

```bash
curl http://127.0.0.1:23119/zotero-agent-mcp/ping                 # 无需令牌；?verbose=1 看全部路由
curl -H "Authorization: Bearer <令牌>" "http://127.0.0.1:23119/zotero-agent-mcp/search?q=社会治理&limit=5"
curl -H "Authorization: Bearer <令牌>" "http://127.0.0.1:23119/zotero-agent-mcp/item/<KEY>/fulltext?maxChars=20000"
curl -H "Authorization: Bearer <令牌>" "http://127.0.0.1:23119/zotero-agent-mcp/item/<KEY>/cite?format=bibtex"
# 纯元数据建条目（一次写全字段/作者/集合/标签）
curl -X POST -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"itemType":"journalArticle","title":"平台用工研究","creators":[{"name":"张三"}],"fields":{"date":"2024","publicationTitle":"社会学研究"},"collections":["文献脉络"],"tags":["agent"]}' \
  http://127.0.0.1:23119/zotero-agent-mcp/item
```

## 能力一览（34 端点 / 34 工具）

| 能力 | 端点 ⇄ 工具 | 作用域 |
|---|---|---|
| 状态自检 | `GET /ping` ⇄ `zotero_ping` | 公开 |
| 库列表（个人+群组） | `/libraries` ⇄ `zotero_libraries` | read |
| 集合树 / 按名搜集合 | `/collections`、`/collections/search` ⇄ `zotero_collections`、`zotero_search_collections` | read |
| 集合内条目 | `/collection/:key/items` ⇄ `zotero_get_collection_items` | read |
| 检索（标题/作者/年份 或 全文） | `/search?q=` ⇄ `zotero_search` | read |
| 最近条目 / 回收站 | `/items/recent`、`/items/trash` ⇄ `zotero_recent`、`zotero_get_trash` | read |
| 条目完整元数据 | `/item/:key` ⇄ `zotero_get_item` | read |
| PDF/EPUB 全文（分页） | `/item/:key/fulltext` ⇄ `zotero_get_fulltext` | fulltext |
| 写全文索引（OCR 等） | `POST /item/:key/fulltext/set` ⇄ `zotero_set_fulltext` | fulltext |
| 高亮与批注 | `/item/:key/annotations` ⇄ `zotero_get_annotations` | annotations |
| 子附件/子笔记 | `/item/:key/children` ⇄ `zotero_get_children` | read |
| 引文/导出（CSL、bibtex、ris…） | `/item/:key/cite` ⇄ `zotero_cite` | export |
| 附件原文件 / 本地路径 | `/item/:key/file`、`/item/:key/path` ⇄ `zotero_get_item`+`file`、`zotero_get_attachment_path` | files |
| 建条目（文件或纯元数据） | `POST /item` ⇄ `zotero_add_item` | write |
| 改条目 / 删条目 | `POST /item/:key/update|delete` ⇄ `zotero_update_item`、`zotero_delete_item` | write |
| 改集合归属 | `POST /item/:key/collections` ⇄ `zotero_set_item_collections` | write |
| 给条目挂文件 | `POST /item/:key/attach` ⇄ `zotero_attach_file` | write |
| 集合增改删 | `POST /collection`、`/collection/:key/update|delete` ⇄ `zotero_create_collection`、`zotero_update_collection`、`zotero_delete_collection` | write |
| 笔记 / 标签 | `POST /note`、`/tag`、`/tags/delete` ⇄ `zotero_add_note`、`zotero_add_tag`、`zotero_delete_tags` | write |
| 库内标签 | `/tags` ⇄ `zotero_get_tags` | read |
| 保存的检索（列表/建/改/删/执行） | `/searches`、`/search/:key/items|update|delete` ⇄ `zotero_get_searches`、`zotero_create_search`、`zotero_update_search`、`zotero_delete_search`、`zotero_run_search` | read/write |
| 字段名自省 | `/schema?itemType=` ⇄ `zotero_get_schema` | read |
| 增量版本同步 | `/versions?type=&since=` ⇄ `zotero_versions` | read |

`library` 参数：`user`（默认）/ 数字 libraryID / `all`（仅 search）。错误统一 `{error, message}`：401 未鉴权 / 403 越权 / 404 不存在 / 400 参数 / 409 只读库 / 415 无法提取 / 503 插件被禁用。

## 安全模型

- 仅绑 `127.0.0.1`；Zotero 自带 Host 校验（防 DNS rebinding）与浏览器请求拦截，响应不发 CORS 头。
- 所有业务端点需 `Authorization: Bearer <令牌>`（或 `X-Agent-Token`）。
- 六个作用域默认全开，可单独关闭；`write` 含条目/集合/笔记/标签的增改（删除默认进回收站，`permanent` 才真删）。
- 客户端配置写入是合并式的（只动 `zotero-agent` 条目）、原子写入（临时文件 + rename）、保留原备份；关掉「启动时自动同步」即只在你点按钮时写。
- 库白名单（留空=全部）、全文分页与附件大小上限。
- 审计日志 `~/Zotero/zotero-agent-mcp-audit.jsonl`（JSONL，可关；只记令牌前 4 位；超过 5MB 每天最多轮转一次）。

## 性能（本机 macOS，Zotero 10.0.9 / node v24）

| 指标 | 数值 |
|---|---|
| 单次 HTTP 请求 | 0–1 ms |
| 桥握手（本地 node 直启，`initialize → tools/list`） | p50 ≈ 25 ms（空闲）/ 33 ms（Zotero 同时运行） |
| `tools/list` 体积 | 12130 B ≈ 3.0k tokens（v0.5.1 为 20619 B） |
| `--tools=core` 13 工具 | 5421 B |
| 插件启动（端点注册→维护完成） | `GET /ping` 的 `startupMs` 字段（实测 17 ms） |

`tools/bench.mjs` 可随时复测（`--baseline` 写基线，默认与 `tools/bench-baseline.json` 对比）。

## 项目结构

```
plugin/                  插件源码（manifest / bootstrap / 核心模块 / prefs.xhtml+prefs.js / clients.json / icons/ / skill/SKILL.md）
bridge/zotero-agent-mcp.mjs  MCP 桥（零依赖 Node，34 工具；随包释放到数据目录）
tools/build.sh           构建 xpi（内嵌 bridge/skill/clients，构建时打印 tools/list 体积）
tools/bench.mjs          握手与上下文体积基准
tools/test_api.sh        HTTP 全端点测试（写库用例用 RUN_NOTE_TEST/CREATE_ITEM_TEST/SET_COLLECTIONS_TEST/MANAGE_TEST 开启）
tools/test_bridge.mjs    MCP 桥 E2E（34 工具 + 体积/描述/annotations/core 集断言）
tools/test_config_merge.mjs  客户端配置合并器回归（对真实 ~/.claude.json、Codex TOML 等做幂等/撤销断言）
tools/install-skill.sh   CLI 版 skill 安装/撤销（面板按钮的无头等价物）
tools/make-icons.py      生成 icons/（PIL，8× 超采样）
DESIGN.md / CHANGELOG.md 设计自问自答 / 版本变更
```

## 测试

```bash
tools/build.sh
TOKEN=$(cat ~/Zotero/zotero-agent-mcp/token)
RUN_NOTE_TEST=1 CREATE_ITEM_TEST=1 MANAGE_TEST=1 tools/test_api.sh "$TOKEN"   # HTTP
ZOTERO_AGENT_TOKEN="$TOKEN" CREATE_ITEM_TEST=1 MANAGE_TEST=1 node tools/test_bridge.mjs  # MCP
node tools/test_config_merge.mjs                                             # 配置写入 / 撤销
node tools/bench.mjs --runs=7                                                # 性能
```

最近一次真机回归（Zotero 10.0.9 macOS）：HTTP **86/86**、MCP E2E **55/55**、配置合并 **45/45**、`tools/list` 体积 58.8%。

## 故障排查

- **安装提示不兼容/损坏**：`manifest.json` 必须有 `update_url`，`strict_max_version` 用 `10.*`（一颗星）。
- **agent 连不上**：设置面板 → 连接测试。若显示「MCP 自检失败」，看提示（Zotero 未运行 / 令牌不符 / node 缺失）。
- **工具报 401**：令牌变了。面板复制令牌，或对标记「令牌不同」的客户端重新复制配置。
- **工具报 403 scope_disabled**：高级设置里打开对应作用域。
- **`npx` 启动慢或握手超时**：改用该行的 `node` 变体（默认），或确认 `npx --prefer-offline` 已缓存；macOS GUI 客户端找不到 `npx` 时用绝对路径（`/usr/local/bin/npx`、`/opt/homebrew/bin/npx`）。
- **只看到 13 个工具**：客户端用了 `--tools=core`。改成默认 `full` 即可恢复 34 个工具。
