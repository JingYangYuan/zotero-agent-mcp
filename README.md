# Zotero-Agent-MCP

让本地 AI agent（ZCode / Claude Code / Cursor / 任意脚本）**快速、安全地读写 Zotero** 的插件。
在 Zotero 内置 HTTP 服务（127.0.0.1:23119）上注册 `/zotero-agent-mcp/` API，并提供**零依赖 MCP 桥**。
**所有功能默认开放**，同时保留令牌鉴权、作用域开关、库白名单、速率限制与审计日志可随时收紧。

已在本机 **Zotero 10.0.2 (macOS)** 真机安装并全量测试通过（HTTP 27/27、MCP E2E 21/21）。

## 功能一览

| 能力 | 端点 / 工具 | 作用域（默认全开） |
|---|---|---|
| 状态自检 | `GET /zotero-agent-mcp/ping` ⇄ `zotero_ping` | 公开 |
| 库列表（个人+群组） | `/libraries` ⇄ `zotero_libraries` | read |
| 集合树 | `/collections` ⇄ `zotero_collections` | read |
| 检索（标题/作者/年份 或 全文） | `/search?q=` ⇄ `zotero_search` | read |
| 最近条目 | `/items/recent` ⇄ `zotero_recent` | read |
| 条目完整元数据 | `/item/:key` ⇄ `zotero_get_item` | read |
| **PDF/EPUB/文本全文**（自动定位最佳附件、分页） | `/item/:key/fulltext` ⇄ `zotero_get_fulltext` | fulltext |
| **高亮与批注** | `/item/:key/annotations` ⇄ `zotero_get_annotations` | annotations |
| 子附件/子笔记 | `/item/:key/children` ⇄ `zotero_get_children` | read |
| **引文**（任意 CSL 样式 + BibTeX） | `/item/:key/cite` ⇄ `zotero_cite` | export |
| 附件原文件（base64） | `/item/:key/file` ⇄ `zotero_get_item`+`file` | files |
| 新增子笔记 | `POST /note` ⇄ `zotero_add_note` | write |
| 增/删标签 | `POST /tag` ⇄ `zotero_add_tag` | write |
| **本地文档建条目**（导入/链接附件、入集合、自动识别元数据） | `POST /item` ⇄ `zotero_add_item` | write |

## 安装

1. 构建：`tools/build.sh`（产物 `build/zotero-agent-mcp` xpi，见 build 目录）。
2. Zotero → 工具 → 插件 → 齿轮 → **Install Plugin From File…** → 选择该 xpi。
3. 设置 → **Zotero-Agent-MCP** 面板：查看/复制访问令牌（所有功能默认已开放）。

> ⚠️ **Zotero 10 兼容要点**（实测踩坑）：`applications.zotero` 中**必须包含 `update_url`**，
> 否则安装会以"文件损坏/不兼容"拒绝（错误码 -3）；`strict_max_version` 用 `10.*`
>（一颗星），两颗星 `10.*.*` 会被版本比较器判定 > `10.0.2` 而不兼容。

## 接入 AI agent（两种方式）

### 方式 A：MCP（推荐，ZCode / Claude / Cursor 通用）
插件已把桥和现成配置释放到 `~/Zotero/zotero-agent-mcp/`。设置面板点"复制 MCP 配置 JSON"，或直接把
`~/Zotero/zotero-agent-mcp/zotero-agent-mcp.mcp.json` 里的 `mcpServers` 块粘贴进 agent 的 MCP 配置：

```json
{
  "mcpServers": {
    "zotero-agent": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/<你>/Zotero/zotero-agent-mcp/zotero-agent-mcp.mjs"],
      "env": {
        "ZOTERO_AGENT_URL": "http://127.0.0.1:23119/zotero-agent-mcp",
        "ZOTERO_AGENT_TOKEN": "<你的令牌>"
      }
    }
  }
}
```

### 方式 B：直接 HTTP
```bash
curl http://127.0.0.1:23119/zotero-agent-mcp/ping
curl -H "Authorization: Bearer <令牌>" "http://127.0.0.1:23119/zotero-agent-mcp/search?q=社会治理&limit=5"
curl -H "Authorization: Bearer <令牌>" "http://127.0.0.1:23119/zotero-agent-mcp/item/<KEY>/fulltext"
curl -H "Authorization: Bearer <令牌>" "http://127.0.0.1:23119/zotero-agent-mcp/item/<KEY>/cite?format=bibtex"
# 把本地 PDF 建为条目并放进集合（mode=link 则只引用原路径不复制）
curl -X POST -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"path":"/path/to/paper.pdf","itemType":"document","collections":["我的收藏"],"tags":["agent"],"recognize":true}' \
  http://127.0.0.1:23119/zotero-agent-mcp/item
```

## 安全模型

- 仅绑定 `127.0.0.1`；Zotero 自带 Host 头校验（防 DNS rebinding）与浏览器请求拦截。
- 所有业务端点需要 `Authorization: Bearer <令牌>`（或 `X-Agent-Token`），令牌可在面板随时重新生成。
- 六个作用域**默认全部开放**，可单独关闭收紧；`write` 仅含新增子笔记、增删标签、本地文件建条目，不提供删除/改写条目本体。
- 库白名单（留空=全部）、速率限制（默认 240 req/min）、全文分页与附件大小上限。
- 审计日志：`~/Zotero/zotero-agent-mcp-audit.jsonl`（JSONL，可关闭；不记录完整令牌）。

## 项目结构

```
plugin/            插件源码（manifest.json / bootstrap.js / zotero-agent-mcp.js / prefs.* / icon.png）
bridge/zotero-agent-mcp.mjs  MCP 桥（零依赖 Node，随包释放到 ~/Zotero/zotero-agent-mcp/）
tools/build.sh     构建 xpi（含把桥打进插件的 bridge-source.js 生成）
tools/test_api.sh  HTTP 全端点测试（含鉴权负例；RUN_NOTE_TEST/CREATE_ITEM_TEST 控制写库用例）
tools/test_bridge.mjs  MCP 桥 E2E（initialize/tools/list/全部 13 工具）
DESIGN.md          grillme 自问自答设计文档 + 验收矩阵
```

## 真机测试结论（Zotero 10.0.2）

- 安装/重启自动加载、令牌持久化、桥文件自动释放 ✅
- HTTP：鉴权负例 401、未知路由 404、坏参数 400、未知条目 404、未知样式 400、
  note/tag/file/建条目 全通 ✅（27/27）
- 全文：中文 PDF 自动提取、`offset/maxChars` 分页 ✅
- 标注、APA 参考文献表、BibTeX 导出 ✅
- 本地 PDF 建条目：附件导入 storage、入集合、打标签 ✅
- MCP 桥：initialize / tools/list（13 工具）/ 全部调用 / 错误语义 ✅（21/21）
- 设置面板渲染与交互（开关即时生效）、中文数据无乱码 ✅

## 故障排查

- **安装提示不兼容/损坏**：确认 manifest 有 `update_url`、`strict_max_version` 为 `10.*`。
- **agent 连不上**：先 `curl .../ping`（无需令牌）；再确认设置面板"启用"已勾选、令牌一致。
- **工具报 scope_disabled**：到设置 → Zotero-Agent-MCP 打开对应开关（默认全开，一般不会遇到）。
- **401**：令牌错误；在面板重新复制。
