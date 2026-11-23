# Changelog

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
