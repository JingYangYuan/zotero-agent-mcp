---
name: zotero-agent
description: 本机 Zotero 文献库操作的统一通道：检索、读写元数据、建/删条目与集合、笔记标签、全文、引文、归档，全部走 zotero-agent MCP 插件的 34 个工具。禁止直接调用 Zotero 本地 API（127.0.0.1:23119/api/**）或 Connector 接口。当任务涉及操作 Zotero、查文献库、文献入库/归档/补元数据/建集合时使用。
---

# Zotero 操作路由（zotero-agent MCP）

本机 Zotero（10.x，Windows）由 **zotero-agent-mcp 插件**提供 MCP 服务，工具前缀 `zotero_`。
本技能是 Zotero 操作的**唯一路由指引**，与其它技能（如文献综述流程技能）中的 Zotero 工具名冲突时，**以本技能为准**。

## 路由铁律

1. **一切 Zotero 操作走 zotero-agent MCP 工具**。插件运行在 Zotero 进程内，能力是本地 API 的超集。
2. **禁止**直接 curl/requests 调用：
   - `http://127.0.0.1:23119/api/**`（Zotero 本地 API v3——写操作还要弹窗授权、维护一次性 key，历史上造成过通道混乱）
   - `http://127.0.0.1:23119/connector/**`（Connector 接口）
3. **缺工具时停下报告**：如果本表没有覆盖所需操作，明确告诉用户"zotero-agent 插件暂不支持 X"，由用户决定是否升级插件；**不要**绕行本地 API。
4. 任何旧文档/旧技能里出现的本地 API 直写配方（Server-ID + authorize 换 key + curl POST /api/users/0/items）**已废弃**。

## 启动自检（每个涉及 Zotero 的任务开始时）

1. `zotero_ping` —— 确认插件在线、版本 ≥ 0.5.0、write 作用域开启。
2. **按任务核对所需写工具**（不要只验检索！）：任务要建集合就调 `zotero_search_collections` 确认现状；要改元数据就先 `zotero_get_schema` 拿字段名。发现工具缺失 → 报告，不要先斩后奏。
3. 涉及批量写（>10 条）时，先在日志里登记计划（建多少、改多少、入哪些集合），再执行。

## 工具映射（34 个，按任务）

### 查找与阅读
| 任务 | 工具 |
|---|---|
| 探活/版本/作用域 | `zotero_ping` |
| 库列表（个人+群组） | `zotero_libraries` |
| 集合树 | `zotero_collections` |
| 按名搜集合（返回父链路径） | `zotero_search_collections` |
| 集合内条目 | `zotero_get_collection_items`（key 或精确名） |
| 检索条目（标题/作者/年份 或 mode=everything 全文） | `zotero_search` |
| 最近修改条目 | `zotero_recent` |
| 单条完整元数据 | `zotero_get_item` |
| 子附件/子笔记 | `zotero_get_children` |
| PDF/EPUB 全文（分页 offset/max_chars） | `zotero_get_fulltext` |
| 高亮与批注 | `zotero_get_annotations` |
| 引文/导出（APA 等 CSL 样式、bibtex/ris/csljson/csv…） | `zotero_cite` |
| 附件本地路径 | `zotero_get_attachment_path` |
| 回收站列表 | `zotero_get_trash` |
| 字段名自省（写元数据前先查） | `zotero_get_schema` |
| 增量版本（跨会话缓存） | `zotero_versions` |
| 库内全部标签 | `zotero_get_tags` |
| 保存的检索：列表/执行 | `zotero_get_searches` / `zotero_run_search` |

### 写入与整理
| 任务 | 工具 |
|---|---|
| 建条目（可带 fields/creators/tags/collections 一次写全；path 可省略=纯元数据） | `zotero_add_item` |
| **补/改元数据**（字段、作者、标签、集合、进/出回收站；可带 version 防冲突） | `zotero_update_item` |
| 改条目集合归属（replace/add/remove） | `zotero_set_item_collections` |
| 给既有条目挂本地文件 | `zotero_attach_file` |
| 删条目（默认进回收站；permanent=true 永删） | `zotero_delete_item` |
| 建集合（含子集合 parent） | `zotero_create_collection` |
| 改集合（改名/移动/进回收站） | `zotero_update_collection` |
| 删集合（成员条目只解除归属不会被删） | `zotero_delete_collection` |
| 加子笔记 | `zotero_add_note` |
| 增/删单条目标签 | `zotero_add_tag` |
| 整库删标签 | `zotero_delete_tags` |
| 保存检索：建/改/删 | `zotero_create_search` / `zotero_update_search` / `zotero_delete_search` |
| 写全文索引（OCR/外部文本进检索） | `zotero_set_fulltext` |

## 别名对照（其它技能/旧文档的工具名 → 本插件）

| 旧名（别再找） | 用这个 |
|---|---|
| `zotero_search_items` / `zotero_advanced_search` | `zotero_search` |
| `zotero_get_item_metadata` | `zotero_get_item` |
| `zotero_get_item_fulltext` / `zotero_read_pdf_pages` / `zotero_get_pdf_outline` | `zotero_get_fulltext`（offset/max_chars 分页） |
| `zotero_get_notes` | `zotero_get_children` |
| `zotero_manage_note` | `zotero_add_note`（建）/ `zotero_update_item`（改，note 字段） |
| `zotero_export_bibliography` | `zotero_cite` |
| `zotero_search_by_tag` | `zotero_search`（tag 参数） |
| `zotero_search_by_citation_key` / `zotero_get_collection_items`（旧义） | `zotero_get_item` / `zotero_get_collection_items` |
| `zotero_semantic_search` | 无——用 `zotero_search` mode=everything |
| `zotero_synthesize_annotations` | 无——读 `zotero_get_annotations` 后自行综合 |
| `zotero_attach_item` | `zotero_attach_file` |
| pyzotero local client / curl 直写本地 API | 全部废弃，用上表工具 |

## 写操作礼仪

- **删除先入回收站**：`zotero_delete_item` 默认即回收站；仅当用户明确要求永久删除才传 `permanent: true`。恢复用 `zotero_update_item {deleted: false}`。
- **改元数据先读后写**：先 `zotero_get_item` 看当前值再 `zotero_update_item`。`version` 参数仅信息性——Zotero 本地保存后版本号异步分配，无法做强冲突校验，不要依赖它防并发。
- **字段名先自省**：不确定字段名（如卷期页 volume/issue/pages、期刊 publicationTitle）先 `zotero_get_schema`；无效字段名会被静默跳过并出现在返回的 `skippedFields` 里——**每次写完检查 skippedFields**。
- **集合归属用 replace 语义时要小心**：`zotero_set_item_collections` mode=replace 是全量替换；想保留原分类用 mode=add。
- **测试/探针数据**打标签 `zotero-agent-mcp-e2e`，方便事后辨认清理。
- 批量写循环调用即可（本地即时生效）；>50 条时在日志里记录进度。

## 故障排查

- 工具报 "Cannot reach Zotero AgentMCP" → Zotero 没开或插件被禁用：让用户打开 Zotero，设置 → Zotero-Agent-MCP 确认"启用服务"勾选。
- 401 → 令牌过期：Zotero 设置面板 → Zotero-Agent-MCP → 复制令牌，更新 agent 的 MCP 配置 env `ZOTERO_AGENT_TOKEN`。
- 403 scope_disabled → 设置面板打开对应作用域。
- 写条目报字段被跳过 → 见 `skippedFields`，用 `zotero_get_schema` 核对字段名。
- 插件本身的问题/功能缺口 → 仓库 `C:\Users\YJY\Desktop\07-开发项目\zotero-agent-mcp`，改完 `tools/build.sh` 出 xpi 重装。
