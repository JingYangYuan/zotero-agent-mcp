# Changelog

## 0.6.2 — 2026-11-26

**面板体验修复 / 20 个 Agent 客户端覆盖 / 移除限流**

### 修复与体验改进
- 修复设置面板「启用服务」复选框未绑定持久化的 `zotero-agent-mcp.enabled` 偏好导致重新打开面板时取消勾选的 bug。
- 移除偏好面板顶部的重复 `Zotero-Agent-MCP` 标题（Zotero 设置页标题栏已显示），保留紧凑的版本号、运行状态与接口地址行。
- 「接入 agent」卡片内置显著的「未在列表中的客户端？手动接入」指引区块，支持一键复制本地 `node` 通用 `mcpServers` JSON、复制 `npx` 配置及同面板展开/收起配置预览。
- 列表中自动将已安装客户端排在顶部，未安装客户端紧随其后。
- 移除无必要的本地 HTTP 速率限制（`rateLimit` / `429 rate_limited`）及高级设置中的速率输入框，避免高频批量文献读写误触发限流。

### 客户端覆盖扩展（9 → 20 个）
- 新增 **Antigravity**、**WorkBuddy**、**GitHub Copilot CLI**、**Factory (Droid)**、**Kimi Code**、**Oh-My-Pi (OMP)**、**CommandCode**、**Amp**（`amp.mcpServers` 格式）、**Trae**（国际版 / 国内版）、**Windsurf**、**Kiro** 的自动检测、配置合并与技能目录映射。

## 0.6.1 — 2026-11-25

**Windows 路径与客户端接入修复 / CI 与自动发布流水线**

### Windows 兼容性修复
- 修复 `expandPath()`、`joinPath()`、`parentDirPath()` 与 `writeAtomic()` 在 Windows 上未将 `/` 统一归一化为 `\` 导致的 `NS_ERROR_FILE_UNRECOGNIZED_PATH`（`could not parse path`）错误，解决点击「接入」/「全部接入」及启动自动同步写入失败与状态漏检问题；优先使用 `IOUtils.writeUTF8(..., { tmpPath })` 原子写入并带 `move` 回退。
- `clients.json` 补全 Windows 路径探测：`vs-code` 增加 `%APPDATA%/Code` 与 `~/.vscode`，`opencode` 增加 `%USERPROFILE%/.config/opencode/opencode.json` 与 `%APPDATA%/opencode` 探测。
- 跳过 Windows 上无法识别的 Unix 路径（如 `/Applications/...`）与未展开的环境变量占位符；`nodePath()` 按平台拆分探测并在 Windows 上解析 `PATH`、`ProgramFiles(x86)`、`%LOCALAPPDATA%\Programs\nodejs` 与 `scoop\shims`。
- 兼容 Windows 客户端配置文件可能携带的 UTF-8 BOM（`\uFEFF`）。
- 桥接脚本 `bridge/zotero-agent-mcp.mjs` 的 `readFallbackToken()` 优先读取同目录 `token` 文件（兼容自定义 Zotero 数据目录），连接测试显式传入 `--url` 与 `--token`。

### TOML / Skill / 面板改进
- 修复 Codex CLI `tomlHeaderRe()` 中的字符转义错误，`tomlStripSection()` 与 `clientStatus()` 统一支持 `\r?\n` 并能跨 `[mcp_servers.zotero-agent.env]` 节正确检测令牌状态。
- `skillTargets()` / `installSkillOne()` 当客户端根目录（如 `~/.claude`）存在但 `skills/` 子目录尚未创建时自动创建 `skills/` 后写入。
- 偏好面板错误提示（toast）包含具体失败客户端及原因，并延长可读展示时间。

### 构建与发布
- 新增 GitHub Actions CI（`.github/workflows/ci.yml`）与自动发布工作流（`.github/workflows/release.yml`）：推送 `v*` 标签或手动触发即自动执行校验与测试、构建 `zotero-agent-mcp.xpi`、生成符合 Zotero 7+ 规范的 `update.json`（`update_link` + `applications.zotero`）、更新 GitHub Release 并同步发布到 npm（支持 `npx zotero-agent-mcp`）。
- 新增 `tools/test_windows_paths.mjs` 覆盖 Windows/Unix 路径归一化、TOML 转义与 BOM 回归断言；`tools/build.sh` 在无 `zip` 命令环境下支持 Python `zipfile` 回退。

## 0.6.0 — 2026-11-23

**性能 / 视觉 / 接入自动化**

### 加载与连接速度
- 插件启动拆成同步段（种子偏好 + 34 条路由 + 偏好面板）与延迟维护段；维护段（令牌对账、文件释放、审计轮转）在 `readyPromise` 后执行，请求进来时自动等待，启动日志新增 `AgentMCP ready in <N>ms`。`/ping` 新增 `startupMs` 便于回归。
- 数据目录文件改为内容比对写：桥脚本、skill、`clients.json`、`version.txt`、`mcp.json`、`agent-configs.json` 内容未变就不落盘（正常启动零写入）。
- 审计轮转改为每天最多一次（`lastAuditRotate`）。
- MCP 桥：`tools/list` 结果启动时序列化一次；响应改为紧凑 JSON（去掉 2 空格缩进）；新增 `--tools=core`（13 个常用工具，5421 字节）与 `ZERO_AGENT_TOOLS` 环境变量。
- 生成给 agent 的配置默认改为**本地 node 直启**（握手 ~25ms，替代 npx 的 0.5–4s），npx 变体一键切换。

### 工具面精简（上下文成本 −41%）
- 34 个工具名称与参数结构不变；描述压到一句话（最长 62 字符），响应体不再 pretty-print。
- 每个工具补 MCP `annotations`（`readOnlyHint` / `destructiveHint`）。
- `tools/list` 从 20619 字节降到 12130 字节（58.8%），约 3.0k tokens。

### 设置面板（极简三件套 + 高级折叠）
- 重排为：状态条 → 服务/令牌 → 一键接入 → 高级设置（默认收起，同面板折叠）。
- 令牌默认掩码显示，带显示/复制/重新生成（重新生成有确认与影响提示）。
- 删除三个"有代码无节点"的死元素；所有复制动作带 toast 反馈。
- 初始化改用 `MutationObserver`（Zotero 在插入 XHTML 片段**之前**加载 pane 脚本，旧的 50ms 轮询可以去掉）。
- 图标：新增 `plugin/icons/`（48/96 品牌图、32/64 侧栏图、SVG 源），注册 `PreferencePanes.image`，面板内使用内联 SVG 线性图标。

### 客户端接入自动化（直接写入）
- 新增 `plugin/clients.json` 注册表：Claude Code、Claude Desktop、Cursor、Codex CLI、Gemini CLI、ZCode、VS Code、OpenCode、Pi agent，支持用户 `<数据目录>/zotero-agent-mcp/clients.local.json` 覆盖/追加。
- **自动写入**：启动时、点「全部接入」时、重置令牌后，把 `zotero-agent` 合并进各客户端配置（`mcpServers`、VS Code `servers`、OpenCode `mcp`、ZCode `mcp.servers`、Codex `[mcp_servers]` TOML）。
- 合并是**文本级**的：只增改自己那一条，其余条目与格式原样保留；修改前备份 `<file>.zotero-agent-mcp.bak`；临时文件 + rename 原子写入；合并后 JSON 校验失败即放弃。
- 幂等：已同步时零写入。可逐行「撤销」或「撤销全部接入」；「启动时自动同步」可关。
- 「连接测试」用 node 真启一次桥接并回读 `/ping`，输出耗时与工具数；桥新增 `--selftest` 单发模式。
- 路由 skill 一键安装（macOS/Linux 软链，Windows 复制）+ 撤销，写入 `<数据目录>/zotero-agent-mcp/skills-installed.json` 清单，只删除自己装的那份。

### HTTP
- `/ping` 精简：`endpoints`（34 行）移到 `?verbose=1`，新增 `endpointCount` 与 `startupMs`。
- `POST /item` 无 `path` 且无标题时返回 400（此前会创建空条目标题）。

### 兼容性修正（Zotero 10 / Firefox 140）
- 移除 `Services.env` 依赖：HOME 通过 `chrome://zotero/content/osfile.mjs` → `FileUtils` → `dirsvc` → `PathUtils` 逐级解析。
- 新增 `joinPath()`：Gecko 的 `PathUtils.join` 对多段相对组件会抛 `NS_ERROR_FILE_UNRECOGNIZED_PATH`，改为逐段拼接并带字符串回退。
- `Subprocess.call` 不做 PATH 解析，`ln`/`rm` 改用绝对路径探测。

### 工具与文档
- 新增 `tools/bench.mjs`（握手/tools-list 体积基准 + 基线对比）、`tools/make-icons.py`；`tools/build.sh` 生成 `clients-source.js` 并在构建时打印 tools/list 体积；`tools/install-skill.sh` 重写为跨平台并支持 `--undo`。
- `SKILL.md` 更新到 v0.6.0（面板路径、连接测试、`--tools=core` 说明）。
- 测试：`test_api.sh` 增加 `/ping` 精简断言；`test_bridge.mjs` 增加 tools/list 体积、描述长度、annotations、`--tools=core` 断言。

## 0.5.1 — 2026-09-29
- Gemini App（npx 单行命令、`--token` CLI 参数、npm bin）。

## 0.5.0 — 2026-09-20
- 对齐本地 API 全部能力：条目/集合/保存检索的增删改、库级标签、全文索引写入、增量版本、字段自省、多格式导出（34 工具）。

## 0.4.x — 2026-08
- 建条目支持 fields/creators 元数据一次写全；改集合归属；Windows 路径归一化修复。

## 0.1–0.3 — 2026-06
- 首个可用版本：令牌鉴权 + 六作用域 + 审计 + 34 端点骨架、MCP 桥、全文/批注/引文。
