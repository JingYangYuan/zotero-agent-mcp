# Zotero-Agent-MCP

让本地 AI agent（ZCode / Claude Code / Cursor / 任意脚本）**快速、安全地读写 Zotero** 的插件。
在 Zotero 内置 HTTP 服务（127.0.0.1:23119）上注册 `/zotero-agent-mcp/` API，并提供**零依赖 MCP 桥（34 个工具）**与**内置 agent 路由 skill**。
插件在进程内直调 Zotero 内部 API，**能力是 Zotero 本地 API 的超集**——agent 无需再绕行 `/api/**`。
**所有功能默认开放**，同时保留令牌鉴权、作用域开关、库白名单、速率限制与审计日志可随时收紧。

已在本机真机安装并全量测试通过：**Zotero 10.0.2 (macOS)** HTTP 27/27、MCP E2E 21/21；
**Zotero 10.0.3 (Windows)** HTTP 45/45（写库闸门全开）、MCP E2E 29/29（14 工具全量）；v0.5.0 工具面见测试章节。

## 功能一览

| 能力 | 端点 / 工具 | 作用域（默认全开） |
|---|---|---|
| 状态自检 | `GET /zotero-agent-mcp/ping` ⇄ `zotero_ping` | 公开 |
| 库列表（个人+群组） | `/libraries` ⇄ `zotero_libraries` | read |
| 集合树 | `/collections` ⇄ `zotero_collections` | read |
| 搜集合（返回父链路径） | `/collections/search?q=` ⇄ `zotero_search_collections` | read |
| 集合内条目 | `/collection/:key/items` ⇄ `zotero_get_collection_items` | read |
| 检索（标题/作者/年份 或 全文） | `/search?q=` ⇄ `zotero_search` | read |
| 最近条目 | `/items/recent` ⇄ `zotero_recent` | read |
| 回收站列表 | `/items/trash` ⇄ `zotero_get_trash` | read |
| 条目完整元数据 | `/item/:key` ⇄ `zotero_get_item` | read |
| **PDF/EPUB/文本全文**（自动定位最佳附件、分页） | `/item/:key/fulltext` ⇄ `zotero_get_fulltext` | fulltext |
| **写全文索引**（OCR/外部文本入检索） | `POST /item/:key/fulltext/set` ⇄ `zotero_set_fulltext` | fulltext |
| **高亮与批注** | `/item/:key/annotations` ⇄ `zotero_get_annotations` | annotations |
| 子附件/子笔记 | `/item/:key/children` ⇄ `zotero_get_children` | read |
| **引文/导出**（任意 CSL 样式 + bibtex/ris/csljson/csv…） | `/item/:key/cite` ⇄ `zotero_cite` | export |
| 附件原文件（base64） | `/item/:key/file` ⇄ `zotero_get_item`+`file` | files |
| 附件本地路径 | `/item/:key/path` ⇄ `zotero_get_attachment_path` | files |
| **建条目**（纯元数据或本地文件 + fields/creators/集合/标签一次写全） | `POST /item` ⇄ `zotero_add_item` | write |
| **改条目元数据**（字段/作者/标签/集合/note/进回收站） | `POST /item/:key/update` ⇄ `zotero_update_item` | write |
| **删条目**（默认回收站，permanent 永删） | `POST /item/:key/delete` ⇄ `zotero_delete_item` | write |
| **改集合归属**（替换/加入/移出，按 key 或精确名，含子集合） | `POST /item/:key/collections` ⇄ `zotero_set_item_collections` | write |
| **给既有条目挂文件** | `POST /item/:key/attach` ⇄ `zotero_attach_file` | write |
| **建集合**（含子集合） | `POST /collection` ⇄ `zotero_create_collection` | write |
| **改集合**（改名/移动/回收站） | `POST /collection/:key/update` ⇄ `zotero_update_collection` | write |
| **删集合**（成员条目只解除归属） | `POST /collection/:key/delete` ⇄ `zotero_delete_collection` | write |
| 新增子笔记 | `POST /note` ⇄ `zotero_add_note` | write |
| 增/删标签 | `POST /tag` ⇄ `zotero_add_tag` | write |
| 库内全部标签 | `/tags` ⇄ `zotero_get_tags` | read |
| 整库删标签 | `POST /tags/delete` ⇄ `zotero_delete_tags` | write |
| 保存的检索：列表 | `/searches` GET ⇄ `zotero_get_searches` | read |
| 保存的检索：创建 | `/searches` POST ⇄ `zotero_create_search` | write |
| 保存的检索：改/删 | `POST /search/:key/update|delete` ⇄ `zotero_update_search` / `zotero_delete_search` | write |
| **执行保存的检索**（web API 都没有的能力） | `/search/:key/items` ⇄ `zotero_run_search` | read |
| 字段名自省 | `/schema?itemType=` ⇄ `zotero_get_schema` | read |
| 增量版本同步 | `/versions?type=&since=` ⇄ `zotero_versions` | read |

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
# 纯元数据建条目（一次写全字段/作者/集合/标签，无需本地文件）
curl -X POST -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"itemType":"journalArticle","title":"平台用工研究","creators":[{"name":"张三"}],"fields":{"date":"2024","publicationTitle":"社会学研究"},"collections":["文献脉络"],"tags":["agent"]}' \
  http://127.0.0.1:23119/zotero-agent-mcp/item
# 或从本地 PDF 建条目并挂附件（mode=link 则只引用原路径不复制）
curl -X POST -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"path":"/path/to/paper.pdf","itemType":"document","collections":["我的收藏"],"recognize":true}' \
  http://127.0.0.1:23119/zotero-agent-mcp/item
# 改条目集合归属：replace（默认，全量替换）/ add / remove；空数组+replace=清空
curl -X POST -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -d '{"mode":"add","collections":["新就业组织·文献脉络"]}' \
  http://127.0.0.1:23119/zotero-agent-mcp/item/<KEY>/collections
```

### 方式 C：内置 agent 路由 skill（推荐给 ZCode）

插件把路由 skill 释放到数据目录 `zotero-agent-mcp/skill/SKILL.md`，内容是"一切 Zotero 操作走
zotero-agent MCP、禁止直调本地 API"的路由铁律 + 34 工具映射表 + 旧工具名对照。装进 ZCode：

```bash
tools/install-skill.sh   # 自动定位数据目录，junction 到 ~/.zcode/skills/zotero-agent
```

更新插件即自动更新 skill（junction 指向释放目录）。

## 安全模型

- 仅绑定 `127.0.0.1`；Zotero 自带 Host 头校验（防 DNS rebinding）与浏览器请求拦截。
- 所有业务端点需要 `Authorization: Bearer <令牌>`（或 `X-Agent-Token`），令牌可在面板随时重新生成。
- 六个作用域**默认全部开放**，可单独关闭收紧；`write` 含条目/集合/笔记/标签的创建与修改（删除默认进回收站，`permanent` 才真删；条目更新支持 version 防冲突），不提供批量清库。
- 库白名单（留空=全部）、速率限制（默认 240 req/min）、全文分页与附件大小上限。
- 审计日志：`~/Zotero/zotero-agent-mcp-audit.jsonl`（JSONL，可关闭；不记录完整令牌）。

## 项目结构

```
plugin/            插件源码（manifest.json / bootstrap.js / zotero-agent-mcp.js / prefs.* / skill/SKILL.md / icon.png）
bridge/zotero-agent-mcp.mjs  MCP 桥（零依赖 Node，34 工具，随包释放到 ~/Zotero/zotero-agent-mcp/）
tools/build.sh     构建 xpi（含把桥和 skill 打进插件的 bridge-source.js / skill-source.js 生成）
tools/test_api.sh  HTTP 全端点测试（含鉴权负例；RUN_NOTE_TEST/CREATE_ITEM_TEST/SET_COLLECTIONS_TEST/MANAGE_TEST 控制写库用例）
tools/test_bridge.mjs  MCP 桥 E2E（initialize/tools/list/全部 34 工具）
tools/authorize_localapi.sh  一次性本地 API 写授权（供测试播种集合，key 缓存 tools/.localapi-key）
tools/install-skill.sh  把插件释放的路由 skill 装进 ~/.zcode/skills（junction）
DESIGN.md          grillme 自问自答设计文档 + 验收矩阵
```

## 真机测试结论（Zotero 10.0.3 Windows，v0.4.1）

- HTTP 套件 45/45（RUN_NOTE_TEST / CREATE_ITEM_TEST / SET_COLLECTIONS_TEST 全开）✅
- MCP 桥 E2E 29/29：14 工具全量，含 fields/creators 元数据回读
  （中文单字段 `{name}`、西文 `{firstName,lastName}`、无效字段进 `skippedFields`）
  与改集合（replace/no-op/按名 add/remove/404/400）✅
- Windows 移植修复（真机回归发现，v0.4.0 时 26/27 唯一失败）：
  新版 Gecko `initWithPath` 拒绝正斜杠路径 → 建条目前归一化分隔符；
  `pathToFile` 抛错改为干净 404。
- Windows 踩坑：MSYS/Git Bash 的 `/tmp` 对 Zotero 进程不可见——测试脚本已用
  `cygpath` 转真实 Windows 路径；python 探测 `python3 || python` + `PYTHONUTF8=1`。
- 改集合用例的集合播种走 Zotero 10 本地 API（写需持久 key）：一次性运行
  `tools/authorize_localapi.sh`（Zotero 弹窗点"始终允许"），key 缓存于 `tools/.localapi-key`。

## 真机测试结论（Zotero 10.0.2 macOS）

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
