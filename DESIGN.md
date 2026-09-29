# Zotero-Agent-MCP — 设计文档（Grillme 自问自答）

> 目标：开发一个 Zotero 插件，让用户在**各种 AI agent**（ZCode / Claude Code / Cursor / ChatWise / 任意本地脚本）中**快速、安全地读取 Zotero 中各种权限范围的内容**（个人库、群组库的元数据、全文、笔记、标注、引文等），并在完成实现后于本机真机测试到无 bug。
>
> 方法：先自我"拷问"（grill me）——用最挑剔的问题逼出需求边界，再实现。

---

## 0. Grillme：硬问题清单与回答

### A. 目标与范围

**Q1. "在各种 agent 当中读取各种权限内容"到底指什么？**
指两件事：(1) **内容面**——Zotero 里用户有权限访问的一切：个人库（My Library）与所有群组库（Group libraries，即"各种权限"）中的条目元数据、摘要、标签、集合结构、PDF/文本附件**全文**、**标注/高亮/批注**、子笔记、以及格式化**引文输出**（APA/BibTeX 等）；(2) **agent 面**——任何能发起本地 HTTP 请求或 MCP 的 agent，插件不应绑定某一家。

**Q2. 为什么不直接用现成的 `zotero-mcp-server`（本机已装，直读 zotero.sqlite）？**
拷问结论：直读 SQLite 有四个硬伤——① Zotero 运行中数据库加锁/WAL，读旧快照；② 无法走 Zotero 内部 API，PDF 全文提取、标注解析、CSL 引文渲染都得重新造轮子；③ 无权限控制，agent 拿到的是整库裸数据；④ 无法安全写入（绕过 Zotero 逻辑直接改库可能损坏库）。**结论：在 Zotero 进程内实现，复用 Zotero API，实时、安全、有权限层。** 插件化是唯一能在进程内注册 HTTP 服务的方式。

**Q3. 为什么不只暴露 Zotero 10 已内置的 `/api/users/0/...` 本地 API？**
拷问：内置本地 API 无鉴权（本机任何进程可读全部数据）、无搜索便捷层、无标注的友好 JSON、无跨 agent 的 MCP 封装、群组库全靠猜 userID。插件在其上叠加：**令牌鉴权 + 分域权限 + 审计 + 便捷端点 + MCP 桥**。不替代它，共存。

**Q4. 用户是新手，安装后第一步是什么？体验闭环是什么？**
装插件 → 打开设置看到面板（启用开关、令牌、权限开关）→ 点"复制 MCP 配置"→ 粘贴进 ZCode/Claude 配置 → agent 直接可用。闭环 ≤ 2 分钟。为此插件必须**自动**：生成令牌、把 MCP 桥脚本释放到数据目录（`~/Zotero/zotero-agent-mcp/zotero-agent-mcp.mjs`）、生成现成的配置 JSON。

### B. 威胁模型与权限（"各种权限"的另一层含义）

**Q5. 谁是攻击者？**
① 本机恶意/失控进程（扫描 23119 端口）；② 浏览器里恶意网页（CSRF/DNS rebinding 探测内网）；③ 过度热情的 agent（死循环拉全文打爆 Zotero）。

**Q6. 逐条对策？**
- ① → **Bearer 令牌**（启动时自动生成 40 位随机串），无令牌 401；审计日志记录每次调用。
- ② → Zotero 自带 Host 头校验（防 DNS rebinding）+ 浏览器发起的请求被 Zotero 取消连接；再叠加令牌（网页拿不到）。响应**不发 CORS 头**，浏览器 JS 读不到。
- ③ → **速率限制**（默认 240 req/min，可关）+ 全文分页（`max_chars`/`offset`，默认上限 200k 字符）。
- 最小权限 → 六个**作用域开关**：`read`（元数据/集合/搜索）、`fulltext`、`annotations`、`export`（引文）、`write`（笔记/标签）、`files`（下载附件原文件，**默认关**）。
- 库级限制 → 可填"允许的 libraryID 白名单"，空=全部。
- 写操作最小化 → 只允许**新增子笔记、增删标签、本地文件建条目、改集合归属**，不允许删除/修改条目本体；群组库只读属性尊重 `editable`。

**Q7. 令牌放哪、会不会泄漏进日志？**
存 `extensions.zotero.zotero-agent-mcp.token`（随插件卸载由 Zotero 清理分支）；审计日志**不记 query string**（防令牌经 `?token=` 泄漏进日志），令牌只记前 4 位指纹。文档仍建议用 Header 传令牌。

**Q8. 时间侧信道？** 本机回环场景风险极低；做长度预检 + 常规比较，文档如实标注。

### C. 架构

**Q9. HTTP 服务怎么起？**
**不自己开端口**。Zotero 10 内置 `Zotero.Server`（127.0.0.1:23119，启动即初始化，Host 校验/浏览器防护齐全）。插件向 `Zotero.Server.Endpoints` 注册 `/zotero-agent-mcp/...` 路由（支持 `:param` 模板），随插件卸载自动注销。零额外端口、零冲突。

**Q10. MCP 桥怎么做才零依赖？**
MCP stdio 传输 = 按行分隔的 JSON-RPC 2.0，手写 300 行 Node 脚本（本机 node v24），零 npm 依赖。插件启动时把桥脚本从 xpi 释放到 `~/Zotero/zotero-agent-mcp/zotero-agent-mcp.mjs`，偏好面板一键复制 `mcpServers` 配置（含 URL+令牌 env）。Agent 侧只需 node。

**Q11. 端点清单（全部 `/zotero-agent-mcp/` 前缀，除 ping 外需令牌）？**

| 方法 | 路径 | 作用域 | 说明 |
|---|---|---|---|
| GET | `/zotero-agent-mcp/ping` | 无 | 状态自检：版本、启用的作用域、库列表 |
| GET | `/zotero-agent-mcp/libraries` | read | 个人库+群组库（id/type/name/editable） |
| GET | `/zotero-agent-mcp/collections?library=` | read | 集合树 |
| GET | `/zotero-agent-mcp/search?q=&library=&tag=&itemType=&mode=&limit=&offset=` | read | 标题/作者/年份或全字段检索 |
| GET | `/zotero-agent-mcp/items/recent?library=&limit=` | read | 最近修改的顶层条目 |
| GET | `/zotero-agent-mcp/item/:key?library=` | read | 条目元数据+子件摘要+最佳附件 |
| GET | `/zotero-agent-mcp/item/:key/fulltext?library=&offset=&maxChars=` | fulltext | 全文（顶层条目自动定位最佳 PDF；走 Zotero 全文索引，未索引自动补索引） |
| GET | `/zotero-agent-mcp/item/:key/annotations?library=` | annotations | 高亮/批注结构化输出 |
| GET | `/zotero-agent-mcp/item/:key/children?library=` | read | 子附件/子笔记 |
| GET | `/zotero-agent-mcp/item/:key/cite?library=&style=&format=` | export | bibliography/citation/bibtex |
| GET | `/zotero-agent-mcp/item/:key/file?library=` | files | 附件原文件（默认关） |
| POST | `/zotero-agent-mcp/item` | write | 建条目 `{path?, title?, itemType?, fields?, creators?, collections?, tags?, mode?, parentKey?, library?, recognize?}`——path 可省略（纯元数据建条目） |
| POST | `/zotero-agent-mcp/item/:key/update` | write | 改条目 `{title?, fields?, creators?, tags?(全量替换), collections?(全量替换), note?, deleted?, version?(信息性), library?}` |
| POST | `/zotero-agent-mcp/item/:key/delete` | write | 删条目 `{permanent?}`——默认进回收站，permanent 永删 |
| POST | `/zotero-agent-mcp/item/:key/collections` | write | 改集合归属 `{collections: [key|精确名], mode?: 'replace'\|'add'\|'remove', library?}` |
| POST | `/zotero-agent-mcp/item/:key/attach` | write | 给既有条目挂本地文件 `{path, mode?, title?, recognize?, library?}` |
| GET | `/zotero-agent-mcp/item/:key/path?library=` | files | 附件本地路径 |
| POST | `/zotero-agent-mcp/item/:key/fulltext/set` | fulltext | 写全文索引 `{content, library?}` |
| GET | `/zotero-agent-mcp/items/trash?library=&limit=` | read | 回收站条目 |
| POST | `/zotero-agent-mcp/collection` | write | 建集合 `{name, parent?, library?}` |
| POST | `/zotero-agent-mcp/collection/:key/update` | write | 改集合 `{name?, parent?(null=顶层), deleted?, library?}` |
| POST | `/zotero-agent-mcp/collection/:key/delete` | write | 删集合 `{permanent?}`——成员条目只解除归属 |
| GET | `/zotero-agent-mcp/collections/search?q=&library=` | read | 按名搜集合（含父链路径） |
| GET | `/zotero-agent-mcp/collection/:key/items?library=&limit=` | read | 集合内条目（key 或精确名） |
| GET | `/zotero-agent-mcp/tags?library=` | read | 库内全部标签 |
| POST | `/zotero-agent-mcp/tags/delete` | write | 整库删标签 `{tags: [名称]≤50, library?}` |
| GET/POST | `/zotero-agent-mcp/searches` | read / write | 保存的检索：列表 / 创建 `{name, conditions:[{condition,operator,value}], library?}` |
| GET | `/zotero-agent-mcp/search/:key/items?library=&limit=` | read | 执行保存的检索（本地 API 独有） |
| POST | `/zotero-agent-mcp/search/:key/update`、`/delete` | write | 改 / 删保存的检索 |
| GET | `/zotero-agent-mcp/schema?itemType=` | read | 字段/创作者角色自省 |
| GET | `/zotero-agent-mcp/versions?type=items\|collections\|searches\|fulltext&since=&library=` | read | 增量版本映射 + 库版本 |
| POST | `/zotero-agent-mcp/note` | write | 给条目加子笔记 `{itemKey, html}` |
| POST | `/zotero-agent-mcp/tag` | write | `{itemKey, tag, action:"add"\|"remove"}` |

`library` 参数：`user`（默认）/ 群组 libraryID 数字 / `all`（仅 search）。错误统一 JSON `{error, message}`：401 未鉴权 / 403 越权 / 404 不存在 / 400 参数 / 409 只读库 / 415 无法提取 / 503 插件被禁用。

**Q12. 关键 Zotero 内部 API（已对照 Zotero 10.0.2 omni.ja 源码确认）**
- 端点：`Zotero.Server.Endpoints["/x/:param"] = class { supportedMethods; supportedDataTypes; init({method, pathname, pathParams, searchParams, headers, data}) → [status, contentType, body] }`；headers 为大小写不敏感代理对象。
- 全文：`Zotero.Fulltext.isCachedMIMEType(item.attachmentContentType)` → `getItemCacheFile(item)` → `Zotero.File.getContentsAsync`；未索引用 `indexItems([id], {ignoreErrors:true})`；纯文本附件直接读 `item.getFilePathAsync()`。
- 搜索：`new Zotero.Search()` + `addCondition('libraryID','is',id)` + `quicksearch-titleCreatorYear`/`quicksearch-everything`。
- 引文：`Zotero.QuickCopy.getContentFromItems(items, "bibliography=<style>")`（同步返回 {text,html}）；BibTeX 用 export 模式 + 回调。
- 笔记/标签：`new Zotero.Item('note')` → `parentItemID` → `setNote` → `saveTx()`；`item.addTag/removeTag` + `saveTx()`。
- 偏好面板：`Zotero.PreferencePanes.register({pluginID, src, scripts})`，插件禁用/卸载自动注销。

**Q13. 顶层条目没有 PDF / PDF 未索引 / 是扫描件？**
返回 404（无附件）/ 415（无法提取文本）+ `message` 说明，绝不 500。已索引但缓存缺失时现场补索引（`indexItems`）。EPUB 走 Zotero 的 fulltext 缓存同样支持。

**Q14. 插件生命周期泄漏？**
`shutdown` 时从 `Zotero.Server.Endpoints` 删除自己注册的每个 key、清空审计定时器；`APP_SHUTDOWN` 直接返回（进程将退出）。重启用同一 ID 重装覆盖。

**Q15. 测试如何算"无 bug"？** 见 §2 验收矩阵——每个端点正/负例、权限负例、持久化、MCP E2E、UI 面板真机截图验证，全部通过才算完成。

## 1. 非目标
- ~~不做删除条目/修改元数据的写接口~~ **v0.5.0 起修订**：为消除 agent 在 MCP 与 Zotero 本地 API v3 之间
  "抢活"绕行（2026-09 论文任务实测返工），插件对齐本地 API 全部能力：条目/集合/保存检索的创建·修改·删除、
  库级标签、全文索引写、增量版本、字段自省、多格式导出。删除默认进回收站（可恢复），`permanent` 显式 opt-in。
  条目更新的 `version` 参数仅信息性——Zotero 本地保存后版本号异步分配（排队落账），读回即回传会误伤，
  故不做强校验（web API 式乐观锁在本地不可靠）。破坏性上界：不提供"清空整库/批量不可恢复删除"类接口。
- 不做多令牌/按 agent 分权（单令牌+全局作用域，文档留升级路径）。
- 不做 GUI 阅读器集成、不做同步。
- 不支持 Zotero 6（bootstrap 插件 7+ 专用）。
- 不搬本地 API 的附件字节替换三段式上传（authorize→upload→register）：给既有条目挂文件用
  `POST /item/:key/attach`（进程内 importFromFile/linkFromFile）替代；亦不搬 connector、publications、群组元数据详情。

## 2. 验收矩阵（真机测试清单）
1. 安装：xpi 拖入 profile → Zotero 启动无错误弹窗，插件管理页显示已启用。
2. 设置面板：可见、可交互；令牌显示/重新生成/复制；六个作用域开关；复制 MCP 配置按钮产出合法 JSON。
3. ping 无令牌可访问；其余端点无令牌 401、错令牌 401。
4. read：libraries/collections/search/recent/item 正常返回真实数据（与库内容核对）。
5. fulltext：有 PDF 的条目返回正文；`offset/maxChars` 分页正确；无附件 404。
6. annotations：有高亮的条目返回结构化标注。
7. cite：bibtex 与 apa bibliography 均有内容。
8. write 默认开？→ 默认**关**。关闭时 POST note/tag 返回 403；开启后成功，且 Zotero UI 中可见新笔记/标签。
9. files 默认关：403；开启后返回文件。
10. 审计日志文件存在、逐条追加、不含令牌。
11. MCP 桥：initialize/tools/list/12 个 tools/call 全通；ZCode 实测可调用。
12. 重启 Zotero：令牌不变、审计继续追加。
13. 中文数据（用户库大量中文文献）标题/全文无乱码。

## 3. 参考
- Zotero 10.0.2 omni.ja：`xpcom/server/server.js`、`server_localAPI.js`、`fulltext.js`、`quickCopy.js`、`search.js`、`preferencePanes.js`
- jasminum 1.1.39（本机已适配 Zotero 10 的 bootstrap 插件样板）
- MCP 规范 stdio 传输（按行分隔 JSON-RPC 2.0）
- 本机已有 `zotero-mcp-server`（直读 SQLite 方案，作为反面参照与结果交叉验证）
