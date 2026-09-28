/* Zotero-Agent-MCP — core module
 * Loaded as a subscript of bootstrap.js with ctx = { Zotero, rootURI, id, version }.
 * Registers HTTP endpoints on Zotero.Server (127.0.0.1:23119) under /zotero-agent-mcp/,
 * guarded by a bearer token, per-scope switches, library allowlist, rate limit,
 * and an append-only audit log. Also releases the MCP bridge script + config
 * into the Zotero data directory.
 *
 * Verified against Zotero 10.0.2 xpcom sources:
 *  - endpoint dispatch: chrome/content/zotero/xpcom/server/server.js
 *  - fulltext: xpcom/fulltext.js, server/server_localAPI.js (ItemFullText)
 *  - quick copy: xpcom/quickCopy.js
 */

var AgentMCP = new function () {
  this.id = null;
  this.version = null;
  this.rootURI = null;

  const PREF = "zotero-agent-mcp.";
  const BASE = "/zotero-agent-mcp";
  const MAX_FULLTEXT_CHARS_DEFAULT = 200000;
  const MAX_FULLTEXT_CHARS_HARD = 2000000;
  const MAX_NOTE_CHARS = 500000;
  const MAX_FILE_BYTES_DEFAULT = 20971520; // 20 MB

  const DEFAULTS = {
    enabled: true,
    "scope-read": true,
    "scope-fulltext": true,
    "scope-annotations": true,
    "scope-export": true,
    "scope-write": true,
    "scope-files": true,
    allowedLibraries: "",
    rateLimit: 240,
    audit: true,
  };

  let registeredEndpoints = [];
  let bridgeReleasedVersion = null;
  let rl = { windowStart: 0, count: 0 };
  let bibtexTranslatorID = null;

  // ---------- errors ----------
  class ABError extends Error {
    constructor(status, code, message) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  this.ABError = ABError;

  // ---------- prefs ----------
  function getPref(key) {
    try {
      return Zotero.Prefs.get(PREF + key);
    } catch (e) {
      return undefined;
    }
  }
  function setPref(key, value) {
    Zotero.Prefs.set(PREF + key, value);
  }
  this.getPref = getPref;
  this.setPref = setPref;

  function seedDefaults() {
    for (let [k, v] of Object.entries(DEFAULTS)) {
      if (getPref(k) === undefined) {
        setPref(k, v);
      }
    }
    // v0.2.0 migration: all scopes now default-open; flip existing installs once
    if (getPref("scopes-open-migrated") === undefined) {
      for (let s of ["read", "fulltext", "annotations", "export", "write", "files"]) {
        setPref("scope-" + s, true);
      }
      setPref("scopes-open-migrated", true);
    }
  }

  function randomString(len) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = "";
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  // Reinstalling/upgrading a plugin wipes its prefs branch, which would rotate
  // the token and break every saved agent config. Keep a copy of the token in
  // the data directory and restore it whenever the pref comes back empty.
  function tokenFilePath() {
    return PathUtils.join(bridgeDir(), "token");
  }

  // One-time migration from the former 'agentbridge' branding (v0.2.x):
  // legacy data dir ~/Zotero/agentbridge and audit file ~/Zotero/agentbridge-audit.jsonl
  async function migrateOldBranding() {
    try {
      let oldDir = PathUtils.join(Zotero.DataDirectory.dir, "agentbridge");
      if (await IOUtils.exists(oldDir)) {
        await IOUtils.makeDirectory(bridgeDir(), { ignoreExisting: true });
        let oldTok = PathUtils.join(oldDir, "token");
        let newTok = tokenFilePath();
        if ((await IOUtils.exists(oldTok)) && !(await IOUtils.exists(newTok))) {
          await IOUtils.move(oldTok, newTok);
        }
        await IOUtils.remove(oldDir, { recursive: true });
      }
      let oldAudit = PathUtils.join(Zotero.DataDirectory.dir, "agentbridge-audit.jsonl");
      if (await IOUtils.exists(oldAudit)) {
        let newAudit = auditPath();
        if (!(await IOUtils.exists(newAudit))) {
          await IOUtils.move(oldAudit, newAudit);
        } else {
          await IOUtils.remove(oldAudit);
        }
      }
    } catch (e) {
      Zotero.debug("ZoteroAgentMCP: legacy migration failed: " + e);
    }
  }

  async function restoreStableToken() {
    let tokFile = tokenFilePath();
    let saved = null;
    try {
      if (await IOUtils.exists(tokFile)) {
        saved = (await IOUtils.readUTF8(tokFile)).trim();
      }
    } catch (e) {}
    let cur = String(getPref("token") || "");
    if (saved) {
      // Authoritative copy exists (survives upgrade pref-wipes) — always adopt it
      if (cur !== saved) {
        setPref("token", saved);
      }
    } else if (!cur) {
      setPref("token", randomString(40));
    }
    let finalTok = String(getPref("token") || "");
    if (finalTok && finalTok !== saved) {
      try {
        await IOUtils.makeDirectory(bridgeDir(), { ignoreExisting: true });
        await IOUtils.writeUTF8(tokFile, finalTok);
      } catch (e) {
        Zotero.debug("AgentMCP: token file write failed: " + e);
      }
    }
  }

  this.regenerateToken = function () {
    let t = randomString(40);
    setPref("token", t);
    IOUtils.writeUTF8(tokenFilePath(), t).catch(() => {});
    releaseBridgeFiles(); // refresh generated config with new token (fire and forget)
    return t;
  };

  function scopeEnabled(scope) {
    if (!scope) return true;
    return !!getPref("scope-" + scope);
  }
  this.scopeEnabled = scopeEnabled;

  function enabledScopes() {
    const all = ["read", "fulltext", "annotations", "export", "write", "files"];
    let o = {};
    for (let s of all) o[s] = scopeEnabled(s);
    return o;
  }

  // ---------- rate limiting (fixed window, in-memory) ----------
  function checkRate() {
    let max = parseInt(getPref("rateLimit") ?? 240, 10);
    if (!max || max <= 0) return true;
    let now = Date.now();
    if (now - rl.windowStart > 60000) {
      rl = { windowStart: now, count: 0 };
    }
    rl.count++;
    return rl.count <= max;
  }

  // ---------- audit ----------
  function auditPath() {
    return PathUtils.join(Zotero.DataDirectory.dir, "zotero-agent-mcp-audit.jsonl");
  }
  this.auditPath = auditPath;

  async function audit(entry) {
    if (!getPref("audit")) return;
    try {
      let path = auditPath();
      let line = JSON.stringify(entry) + "\n";
      if (await IOUtils.exists(path)) {
        await IOUtils.writeUTF8(path, line, { mode: "append" });
      } else {
        await IOUtils.writeUTF8(path, line);
      }
    } catch (e) {
      Zotero.debug("AgentMCP: audit write failed: " + e);
    }
  }

  async function rotateAuditIfHuge() {
    try {
      let path = auditPath();
      let stat = await IOUtils.stat(path);
      if (stat && stat.size > 5 * 1024 * 1024) {
        let backup = PathUtils.join(Zotero.DataDirectory.dir, "zotero-agent-mcp-audit.jsonl.1");
        await IOUtils.remove(backup, { ignoreAbsent: true });
        await IOUtils.move(path, backup);
      }
    } catch (e) {
      // no file yet
    }
  }

  // ---------- auth ----------
  function extractToken(options) {
    let h = options.headers || {};
    let auth = h.authorization || "";
    if (/^bearer\s+/i.test(auth)) {
      return String(auth.replace(/^bearer\s+/i, "")).trim();
    }
    if (h["x-agent-token"]) {
      return String(h["x-agent-token"]).trim();
    }
    try {
      return (options.searchParams.get("token") || "").trim();
    } catch (e) {
      return "";
    }
  }

  // ---------- library helpers ----------
  async function resolveLibrary(param) {
    if (!param || param === "user" || param === "my" || param === "mylibrary") {
      return Zotero.Libraries.userLibraryID;
    }
    if (param === "all") {
      throw new ABError(400, "bad_request", "'all' is only valid on /search; give a libraryID for this endpoint (see /libraries)");
    }
    if (!/^\d+$/.test(String(param))) {
      throw new ABError(400, "bad_request", `Unknown library '${param}' — use 'user' or a numeric libraryID from /zotero-agent-mcp/libraries`);
    }
    let id = parseInt(param, 10);
    if (Zotero.Libraries.exists(id)) {
      return checkLibraryAllowed(id);
    }
    // Maybe they passed a Zotero *group* id rather than the internal libraryID
    try {
      let groups = await Zotero.Groups.getAll();
      let g = groups.find((x) => x.id === id);
      if (g && Zotero.Libraries.exists(g.libraryID)) {
        return checkLibraryAllowed(g.libraryID);
      }
    } catch (e) {}
    throw new ABError(404, "not_found", `No such library: ${param}`);
  }

  function checkLibraryAllowed(libraryID) {
    let allow = String(getPref("allowedLibraries") || "").trim();
    if (allow) {
      let list = allow.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => !isNaN(n));
      if (list.length && !list.includes(libraryID)) {
        throw new ABError(403, "library_not_allowed", `Library ${libraryID} is not in the allowedLibraries list`);
      }
    }
    return libraryID;
  }

  function requireEditable(libraryID) {
    let lib = Zotero.Libraries.get(libraryID);
    if (!lib || !lib.editable) {
      throw new ABError(409, "library_readonly", `Library ${libraryID} is not editable`);
    }
  }

  async function allLibrariesJSON() {
    let out = [];
    let allow = String(getPref("allowedLibraries") || "").trim();
    let list = allow
      ? allow.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => !isNaN(n))
      : null;
    for (let lib of Zotero.Libraries.getAll()) {
      let id = lib.libraryID;
      let type = Zotero.Libraries.getType(id);
      if (type === "feed") continue;
      if (list && !list.includes(id)) continue;
      out.push({
        id,
        type,
        name: Zotero.Libraries.getName(id),
        editable: !!lib.editable,
      });
    }
    return out;
  }
  this.allLibrariesJSON = allLibrariesJSON;

  // ---------- item serialization ----------
  async function itemToJSON(item, opts = {}) {
    let d = {};
    try {
      d = item.toJSON() || {};
    } catch (e) {}
    let out = {
      key: item.key,
      libraryID: item.libraryID,
      library: Zotero.Libraries.getName(item.libraryID),
      itemType: d.itemType || item.getItemTypeName(),
    };
    if (item.parentKey) out.parentKey = item.parentKey;
    for (let [k, v] of Object.entries(d)) {
      if (k === "itemType" || k === "version" || k in out) continue;
      if (v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
      out[k] = v;
    }
    out.dateAdded = item.dateAdded;
    out.dateModified = item.dateModified;
    if (item.isRegularItem()) {
      try {
        let best = await item.getBestAttachment();
        if (best) out.bestAttachmentKey = best.key;
      } catch (e) {}
      let nAtt = item.getAttachments().length;
      let nNotes = item.getNotes().length;
      if (nAtt) out.numAttachments = nAtt;
      if (nNotes) out.numNotes = nNotes;
      try {
        let annIDs = item.getAnnotations();
        if (annIDs && annIDs.length) out.numAnnotations = annIDs.length;
      } catch (e) {}
    }
    if (item.isFileAttachment() && opts.detail) {
      out.contentType = item.attachmentContentType;
      out.filename = item.attachmentFilename;
    }
    return out;
  }

  // ---------- search ----------
  async function doSearch(libraryID, q, mode, tag, itemType) {
    let s = new Zotero.Search();
    s.libraryID = libraryID;
    s.addCondition(mode, "contains", q);
    if (tag) s.addCondition("tag", "is", tag);
    if (itemType) s.addCondition("itemType", "is", itemType);
    return s.search();
  }

  function clampInt(v, min, max, def) {
    let n = parseInt(v, 10);
    if (isNaN(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  async function findItem(libraryID, key) {
    if (!key || !/^[A-Z0-9]{8}$/.test(String(key))) {
      throw new ABError(400, "bad_request", "item key must be an 8-character Zotero key like 'ABCD1234'");
    }
    let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
    if (!item || item.deleted) {
      throw new ABError(404, "not_found", `No item '${key}' in library ${libraryID}`);
    }
    return item;
  }

  // ---------- fulltext ----------
  async function resolveAttachment(item) {
    if (item.isNote()) return null;
    if (item.isFileAttachment()) return item;
    if (item.isRegularItem()) {
      let best = null;
      try {
        best = await item.getBestAttachment();
      } catch (e) {}
      if (best) return best;
      let atts = Zotero.Items.get(item.getAttachments());
      for (let a of atts) {
        if (a.attachmentContentType === "application/pdf") return a;
      }
      if (atts.length) return atts[0];
    }
    return null;
  }

  async function getFulltext(item, offset, maxChars) {
    // Notes: return note text directly
    if (item.isNote()) {
      let html = item.getNote();
      let text = htmlToText(html);
      return sliceFulltext({ content: text, contentType: "text/plain", sourceType: "note" }, offset, maxChars);
    }
    let att = await resolveAttachment(item);
    if (!att) {
      throw new ABError(404, "no_attachment", "Item has no readable attachment (need a PDF/EPUB/text file attachment)");
    }
    let contentType = att.attachmentContentType;
    if (Zotero.Fulltext.isCachedMIMEType(contentType)) {
      let file = Zotero.Fulltext.getItemCacheFile(att);
      if (!file || !file.exists()) {
        try {
          await Zotero.Fulltext.indexItems([att.id], { ignoreErrors: true });
        } catch (e) {}
      }
      if (!file || !file.exists()) {
        throw new ABError(415, "extraction_unavailable", `Attachment '${att.key}' (${contentType}) has no extractable text layer (scanned PDF without OCR?)`);
      }
      let content = await Zotero.File.getContentsAsync(file.path || file);
      let extra = {};
      try {
        let row = await Zotero.DB.rowQueryAsync(
          "SELECT indexedPages, totalPages, indexedChars, totalChars FROM fulltextItems WHERE itemID=?",
          [att.id]
        );
        if (row) {
          if (row.totalPages != null) extra.totalPages = row.totalPages;
          if (row.totalChars != null) extra.totalChars = row.totalChars;
        }
      } catch (e) {}
      return sliceFulltext({ content, contentType, sourceType: "fulltext-cache", attachmentKey: att.key, extra }, offset, maxChars);
    }
    // Non-cacheable but textual: read the file itself
    if (/^text\//i.test(contentType) || /json|xml|csv/i.test(contentType)) {
      let path = await att.getFilePathAsync();
      if (!path) throw new ABError(404, "file_missing", "Attachment file not found on disk");
      let content = await Zotero.File.getContentsAsync(path);
      return sliceFulltext({ content, contentType, sourceType: "file", attachmentKey: att.key }, offset, maxChars);
    }
    throw new ABError(415, "unsupported_type", `Content type '${contentType}' is not text-extractable`);
  }

  function sliceFulltext({ content, contentType, sourceType, attachmentKey, extra }, offset, maxChars) {
    let total = content.length;
    let off = Math.max(0, offset || 0);
    let max = Math.min(maxChars || MAX_FULLTEXT_CHARS_DEFAULT, MAX_FULLTEXT_CHARS_HARD);
    let slice = content.slice(off, off + max);
    let out = {
      contentType,
      sourceType,
      totalChars: total,
      offset: off,
      returnedChars: slice.length,
      truncated: off + slice.length < total,
      content: slice,
      ...(attachmentKey ? { attachmentKey } : {}),
      ...(extra || {}),
    };
    if (out.truncated) out.nextOffset = off + slice.length;
    return out;
  }

  function htmlToText(html) {
    return String(html)
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h\d|li|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ---------- annotations ----------
  async function annotationsJSON(item) {
    let ids = [];
    try {
      ids = item.getAnnotations() || [];
    } catch (e) {}
    if (!ids.length) return [];
    let anns = await Zotero.Items.getAsync(ids);
    let out = [];
    for (let ann of anns) {
      if (ann.deleted) continue;
      let pos = null;
      let posRaw = ann.getField("annotationPosition");
      try {
        pos = posRaw ? JSON.parse(posRaw) : null;
      } catch (e) {}
      let parentKey = null;
      try {
        let p = Zotero.Items.get(ann.parentItemID);
        if (p) parentKey = p.key;
      } catch (e) {}
      out.push({
        key: ann.key,
        attachmentKey: parentKey,
        type: ann.getField("annotationType") || null,
        text: ann.getField("annotationText") || null,
        comment: ann.getField("annotationComment") || null,
        color: ann.getField("annotationColor") || null,
        pageLabel: ann.getField("annotationPageLabel") || null,
        pageName: ann.getField("annotationPageName") || null,
        pageIndex: pos ? pos.pageIndex : null,
        sortIndex: ann.getField("annotationSortIndex") || null,
        author: ann.getField("annotationAuthorName") || null,
        dateModified: ann.dateModified,
      });
    }
    out.sort((a, b) => String(a.sortIndex).localeCompare(String(b.sortIndex)));
    return out;
  }

  // ---------- cite ----------
  async function citeJSON(items, params) {
    let format = (params.get("format") || "bibliography").toLowerCase();
    if (!["bibliography", "citation", "bibtex"].includes(format)) {
      throw new ABError(400, "bad_request", "format must be bibliography | citation | bibtex");
    }
    if (format === "bibtex") {
      let text = await exportBibtex(items);
      return { format, text };
    }
    let styleParam = params.get("style") || "apa";
    let styleID = styleParam.startsWith("http") ? styleParam : "http://www.zotero.org/styles/" + styleParam;
    let style = null;
    try {
      style = Zotero.Styles.get(styleID);
    } catch (e) {}
    if (!style) {
      try {
        style = Zotero.Styles.getAll().find(
          (s) => s.styleID === styleID || String(s.title).toLowerCase() === styleParam.toLowerCase()
        );
        if (style) styleID = style.styleID;
      } catch (e) {}
    }
    if (!style) {
      throw new ABError(400, "unknown_style", `CSL style '${styleParam}' not installed. Try 'apa', 'chicago-note-bibliography', 'ieee', 'chinese-gb7714-2005-numeric', or any installed style id.`);
    }
    let res = Zotero.QuickCopy.getContentFromItems(items, "bibliography=" + styleID, null, format === "citation");
    if (!res) {
      throw new ABError(500, "cite_failed", "Zotero.QuickCopy.getContentFromItems returned false (drag limit?)");
    }
    return { format, style: styleID, text: res.text, html: res.html };
  }

  async function exportBibtex(items) {
    if (!bibtexTranslatorID) {
      let all = await Zotero.Translators.getAll();
      let t = all.find((x) => x.label === "BibTeX");
      if (!t) throw new ABError(500, "translator_missing", "BibTeX translator not found");
      bibtexTranslatorID = t.translatorID;
    }
    let translation = new Zotero.Translate.Export();
    translation.setItems(items.slice());
    translation.setTranslator(bibtexTranslatorID);
    let done = new Promise((resolve) => {
      translation.setHandler("done", (obj, worked) => resolve(worked ? obj.string || "" : ""));
    });
    await translation.translate();
    let text = await done;
    if (!text) throw new ABError(500, "cite_failed", "BibTeX export produced no output");
    return text;
  }

  // ---------- children ----------
  async function childrenJSON(item) {
    let out = { attachments: [], notes: [] };
    try {
      let atts = Zotero.Items.get(item.getAttachments());
      for (let a of atts) {
        if (a.deleted) continue;
        out.attachments.push({
          key: a.key,
          title: a.getField("title") || null,
          filename: a.attachmentFilename || null,
          contentType: a.attachmentContentType || null,
          linkMode: a.attachmentLinkMode,
          md5: a.attachmentMD5 || null,
        });
      }
    } catch (e) {}
    try {
      let notes = Zotero.Items.get(item.getNotes());
      for (let n of notes) {
        if (n.deleted) continue;
        out.notes.push({
          key: n.key,
          text: htmlToText(n.getNote()).slice(0, 2000),
          dateModified: n.dateModified,
        });
      }
    } catch (e) {}
    return out;
  }

  // ---------- collections ----------
  async function collectionsJSON(libraryID) {
    // recursive=true — otherwise only top-level collections are returned
    let cols = Zotero.Collections.getByLibrary(libraryID, true);
    let byParent = new Map();
    let info = new Map();
    for (let c of cols) {
      if (c.deleted) continue;
      info.set(c.id, c);
      let p = c.parentID || 0;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(c);
    }
    function build(cid) {
      return (byParent.get(cid) || [])
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map((c) => ({
          key: c.key,
          name: c.name,
          children: build(c.id),
        }));
    }
    return build(0);
  }

  // ---------- recent ----------
  async function recentItems(libraryID, limit) {
    let rows = await Zotero.DB.queryAsync(
      `SELECT i.itemID AS itemID FROM items i
       JOIN itemTypes it USING (itemTypeID)
       WHERE i.libraryID = ?
         AND it.typeName NOT IN ('note', 'attachment', 'annotation')
         AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
       ORDER BY i.dateModified DESC LIMIT ?`,
      [libraryID, limit]
    );
    let ids = rows.map((r) => r.itemID);
    return Zotero.Items.getAsync(ids);
  }

  // ---------- MCP bridge release ----------
  function bridgeDir() {
    return PathUtils.join(Zotero.DataDirectory.dir, "zotero-agent-mcp");
  }
  this.bridgeDir = bridgeDir;
  this.bridgePath = function () {
    return PathUtils.join(bridgeDir(), "zotero-agent-mcp.mjs");
  };

  async function releaseBridgeFiles() {
    let src = AgentMCP._bridgeSource;
    if (!src) return;
    let dir = bridgeDir();
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    let dest = AgentMCP.bridgePath();
    let stamp = PathUtils.join(dir, "version.txt");
    let cur = null;
    try {
      cur = await IOUtils.readUTF8(stamp);
    } catch (e) {}
    if (cur !== String(AgentMCP.version) || !(await IOUtils.exists(dest))) {
      await IOUtils.writeUTF8(dest, src);
    }
    await IOUtils.writeUTF8(stamp, String(AgentMCP.version));
    // convenience config file
    let cfg = {
      _comment: "Paste the 'mcpServers' block into your agent's MCP config. Works with ZCode, Claude Desktop/Code, Cursor, etc.",
      url: `http://127.0.0.1:23119/zotero-agent-mcp`,
      token: getPref("token"),
      bridge: dest,
      mcpServers: {
        "zotero-agent": {
          type: "stdio",
          command: "node",
          args: [dest],
          env: {
            ZOTERO_AGENT_URL: "http://127.0.0.1:23119/zotero-agent-mcp",
            ZOTERO_AGENT_TOKEN: getPref("token"),
          },
        },
      },
    };
    await IOUtils.writeUTF8(PathUtils.join(dir, "zotero-agent-mcp.mcp.json"), JSON.stringify(cfg, null, 2));
    bridgeReleasedVersion = String(AgentMCP.version);
  }
  this.releaseBridgeFiles = releaseBridgeFiles;
  this.bridgeReleasedVersion = () => bridgeReleasedVersion;

  // ---------- HTTP plumbing ----------
  function errBody(code, message) {
    return { error: code, message };
  }

  function makeEndpoint(scope, handler, opts = {}) {
    const ep = class {
      supportedMethods = opts.methods || ["GET"];
      supportedDataTypes = ["application/json"];
      async init(options) {
        return AgentMCP.handle(options, scope, handler);
      }
    };
    return ep;
  }

  this.handle = async function (options, scope, handler) {
    let t0 = Date.now();
    let status = 500;
    let body;
    let tokenSeen = "";
    try {
      if (!getPref("enabled")) {
        status = 503;
        body = errBody("disabled", "Zotero-Agent-MCP is disabled in Zotero Settings → AgentMCP");
      } else if (!checkRate()) {
        status = 429;
        body = errBody("rate_limited", "Rate limit exceeded (see AgentMCP settings)");
      } else {
        tokenSeen = extractToken(options);
        let real = String(getPref("token") || "");
        if (scope && (!tokenSeen || tokenSeen !== real)) {
          status = 401;
          body = errBody("unauthorized", "Missing or invalid token. Pass header 'Authorization: Bearer <token>' or 'X-Agent-Token: <token>'. Token is in Zotero Settings → AgentMCP.");
        } else if (!scopeEnabled(scope)) {
          status = 403;
          body = errBody("scope_disabled", `Scope '${scope}' is disabled in Zotero Settings → AgentMCP`);
        } else {
          let ctx = {
            method: options.method,
            pathname: options.pathname,
            pathParams: options.pathParams || {},
            params: options.searchParams,
            data: options.data,
          };
          let result = await handler(ctx);
          status = 200;
          body = result;
        }
      }
    } catch (e) {
      if (e instanceof ABError) {
        status = e.status;
        body = errBody(e.code, e.message);
      } else {
        Zotero.logError(e);
        status = 500;
        body = errBody("internal", String((e && e.message) || e));
      }
    }
    audit({
      t: new Date().toISOString(),
      path: options.pathname,
      method: options.method,
      status,
      scope: scope || "-",
      token: tokenSeen ? tokenSeen.slice(0, 4) + "…" : "-",
      ms: Date.now() - t0,
    });
    return [status, "application/json", JSON.stringify(body)];
  };

  // ---------- route handlers ----------
  async function hPing() {
    let port = null;
    try {
      port = Zotero.Server.port;
    } catch (e) {}
    return {
      plugin: "zotero-agent-mcp",
      version: String(AgentMCP.version),
      zoteroVersion: Zotero.version,
      baseUrl: `http://127.0.0.1:${port}${BASE}`,
      enabled: !!getPref("enabled"),
      scopes: enabledScopes(),
      libraries: await allLibrariesJSON(),
      endpoints: ROUTES.map((r) => `${(r.methods || ["GET"]).join("/")} ${r.path}${r.scope ? `  [${r.scope}]` : "  [public]"}`),
      time: new Date().toISOString(),
    };
  }

  const hLibraries = async () => ({ libraries: await allLibrariesJSON() });

  const hCollections = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    return { libraryID, collections: await collectionsJSON(libraryID) };
  };

  const hSearch = async (ctx) => {
    let q = (ctx.params.get("q") || "").trim();
    if (!q) {
      throw new ABError(400, "bad_request", "Missing 'q' query parameter (use /items/recent for recent items)");
    }
    let libParam = ctx.params.get("library") || "user";
    let limit = clampInt(ctx.params.get("limit"), 1, 100, 25);
    let offset = clampInt(ctx.params.get("offset"), 0, 1000000, 0);
    let mode = ctx.params.get("mode") === "everything" ? "quicksearch-everything" : "quicksearch-titleCreatorYear";
    let tag = ctx.params.get("tag") || null;
    let itemType = ctx.params.get("itemType") || null;
    let libs = [];
    if (libParam === "all") {
      for (let l of await allLibrariesJSON()) libs.push(l.id);
    } else {
      libs.push(await resolveLibrary(libParam));
    }
    let all = [];
    for (let libraryID of libs) {
      if (!q) continue;
      let ids = await doSearch(libraryID, q, mode, tag, itemType);
      all.push(...ids);
    }
    let items = await Zotero.Items.getAsync(all);
    items = items.filter((i) => i.isRegularItem() && !i.deleted);
    items.sort((a, b) => String(b.dateModified).localeCompare(String(a.dateModified)));
    let total = items.length;
    let page = items.slice(offset, offset + limit);
    return {
      query: q,
      mode,
      total,
      offset,
      limit,
      hasMore: offset + page.length < total,
      items: await Promise.all(page.map((i) => itemToJSON(i))),
    };
  };

  const hRecent = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let limit = clampInt(ctx.params.get("limit"), 1, 100, 20);
    let items = await recentItems(libraryID, limit);
    return {
      libraryID,
      items: await Promise.all(items.map((i) => itemToJSON(i))),
    };
  };

  const hItem = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let item = await findItem(libraryID, ctx.pathParams.key);
    let out = await itemToJSON(item);
    out.children = await childrenJSON(item);
    return out;
  };

  const hFulltext = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let item = await findItem(libraryID, ctx.pathParams.key);
    let offset = clampInt(ctx.params.get("offset"), 0, 100000000, 0);
    let maxChars = clampInt(ctx.params.get("maxChars"), 100, MAX_FULLTEXT_CHARS_HARD, MAX_FULLTEXT_CHARS_DEFAULT);
    let out = await getFulltext(item, offset, maxChars);
    out.key = item.key;
    out.libraryID = libraryID;
    return out;
  };

  const hAnnotations = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let item = await findItem(libraryID, ctx.pathParams.key);
    return { key: item.key, annotations: await annotationsJSON(item) };
  };

  const hChildren = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let item = await findItem(libraryID, ctx.pathParams.key);
    return { key: item.key, ...(await childrenJSON(item)) };
  };

  const hCite = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let item = await findItem(libraryID, ctx.pathParams.key);
    let out = await citeJSON([item], ctx.params);
    out.key = item.key;
    return out;
  };

  const hFile = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let item = await findItem(libraryID, ctx.pathParams.key);
    let att = await resolveAttachment(item);
    if (!att) throw new ABError(404, "no_attachment", "No attachment to download");
    let path = await att.getFilePathAsync();
    if (!path) throw new ABError(404, "file_missing", "Attachment file not found on disk");
    let stat = await IOUtils.stat(path);
    let maxBytes = MAX_FILE_BYTES_DEFAULT;
    if (stat.size > maxBytes) {
      throw new ABError(413, "file_too_large", `File is ${stat.size} bytes; limit is ${maxBytes}`);
    }
    let bytes = await IOUtils.read(path);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return {
      key: att.key,
      filename: att.attachmentFilename || null,
      contentType: att.attachmentContentType || null,
      size: stat.size,
      base64: btoa(bin),
    };
  };

  const hNote = async (ctx) => {
    if (ctx.method !== "POST") throw new ABError(400, "bad_request", "POST JSON {itemKey, html, library?}");
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    let parent = await findItem(libraryID, data.itemKey || data.key);
    let html = String(data.html ?? "").slice(0, MAX_NOTE_CHARS);
    if (!html.trim()) throw new ABError(400, "bad_request", "'html' must be a non-empty note body");
    if (!/<[a-z][\s\S]*>/i.test(html)) {
      html = "<p>" + html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>") + "</p>";
    }
    let note = new Zotero.Item("note");
    note.libraryID = libraryID;
    note.parentItemID = parent.id;
    note.setNote(html);
    await note.saveTx();
    return { created: true, key: note.key, parentKey: parent.key };
  };

  // Create a new item from a local file and (optionally) file it into collections.
  // POST JSON: {path, title?, itemType?, fields?, creators?, collections?[], tags?[],
  //             mode? 'import'|'link', parentKey?, library?, recognize?}
  async function resolveCollectionKeyOrName(libraryID, s) {
    let cols = Zotero.Collections.getByLibrary(libraryID);
    let c = cols.find((x) => !x.deleted && (x.key === s || x.name === s));
    if (!c) {
      throw new ABError(404, "not_found", `No collection '${s}' in library ${libraryID} (match by collection key or exact name)`);
    }
    return c;
  }

  const hCreateItem = async (ctx) => {
    if (ctx.method !== "POST") {
      throw new ABError(400, "bad_request", "POST JSON {path, title?, itemType?, fields?, creators?, collections?, tags?, mode?, parentKey?, library?, recognize?}");
    }
    let data = ctx.data || {};
    let path = String(data.path || "").trim();
    if (!path) throw new ABError(400, "bad_request", "'path' (absolute local file path) is required");
    // Windows: newer Gecko rejects forward slashes in initWithPath, and drive-less
    // paths throw — agents naturally emit forward-slash paths, so normalize first.
    if (Zotero.isWin) path = path.replace(/\//g, "\\");
    let file;
    try {
      file = Zotero.File.pathToFile(path);
    } catch (e) {
      throw new ABError(404, "file_not_found", `File not found: ${path}`);
    }
    if (!file.exists()) {
      throw new ABError(404, "file_not_found", `File not found: ${path}`);
    }
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);

    let mode = (data.mode || "import").toLowerCase();
    if (!["import", "link"].includes(mode)) {
      throw new ABError(400, "bad_request", "mode must be 'import' (copy into Zotero storage) or 'link' (reference the original path)");
    }

    let fileName = file.leafName;
    let parent = null;
    let item = null;
    let skippedFields = [];
    if (data.parentKey) {
      parent = await findItem(libraryID, data.parentKey);
      if (!parent.isRegularItem()) {
        throw new ABError(400, "bad_request", "parentKey must reference a regular (top-level) item");
      }
    } else {
      let itemType = String(data.itemType || "document");
      let typeID = Zotero.ItemTypes.getID(itemType);
      if (!typeID) {
        throw new ABError(400, "bad_request", `Unknown itemType '${itemType}' (e.g. document, journalArticle, book, report, thesis)`);
      }
      item = new Zotero.Item(itemType);
      item.libraryID = libraryID;
      item.setField("title", String(data.title || fileName.replace(/\.[^.]+$/, "")));
      // Optional full metadata: `fields` maps Zotero field names to values (date, publicationTitle,
      // abstractNote, DOI, …); invalid/inapplicable field names are skipped, not fatal.
      if (data.fields && typeof data.fields === "object" && !Array.isArray(data.fields)) {
        for (let [fieldName, value] of Object.entries(data.fields)) {
          if (fieldName === "title" || value === undefined || value === null || value === "") continue;
          try {
            item.setField(String(fieldName), String(value));
          } catch (e) {
            skippedFields.push(String(fieldName));
          }
        }
      }
      // `creators` accepts Zotero creator JSON: {creatorType?, name} for single-field names
      // (common for Chinese authors) or {creatorType?, firstName, lastName}.
      if (Array.isArray(data.creators)) {
        let creators = [];
        for (let c of data.creators.slice(0, 200)) {
          if (!c || typeof c !== "object") continue;
          let creatorType = String(c.creatorType || "author");
          if (!Zotero.CreatorTypes.getID(creatorType)) creatorType = "author";
          if (c.name) {
            creators.push({ creatorType, name: String(c.name), fieldMode: 1 });
          } else if (c.lastName || c.firstName) {
            creators.push({ creatorType, lastName: String(c.lastName || ""), firstName: String(c.firstName || ""), fieldMode: 0 });
          }
        }
        if (creators.length) item.setCreators(creators);
      }
      if (Array.isArray(data.tags)) {
        for (let t of data.tags.slice(0, 50)) {
          let tag = String(t || "").trim();
          if (tag && !item.hasTag(tag)) item.addTag(tag);
        }
      }
      if (Array.isArray(data.collections) && data.collections.length) {
        let collectionIDs = [];
        for (let c of data.collections.slice(0, 50)) {
          let col = await resolveCollectionKeyOrName(libraryID, String(c));
          collectionIDs.push(col.id);
        }
        item.setCollections(collectionIDs);
      }
      await item.saveTx();
    }

    let parentItemID = parent ? parent.id : item.id;
    let attOpts = {
      file,
      parentItemID,
      title: data.attachmentTitle ? String(data.attachmentTitle) : undefined,
    };
    let att;
    try {
      att = mode === "link"
        ? await Zotero.Attachments.linkFromFile(attOpts)
        : await Zotero.Attachments.importFromFile(attOpts);
    } catch (e) {
      if (!parent && item) {
        await item.eraseTx();
      }
      throw new ABError(415, "attach_failed", `Could not attach file: ${e && e.message ? e.message : e}`);
    }

    if (data.recognize) {
      try {
        Zotero.RecognizeDocument.recognizeItems([att]);
      } catch (e) {
        Zotero.debug("AgentMCP: recognize failed: " + e);
      }
    }

    return {
      created: true,
      mode,
      itemKey: item ? item.key : parent.key,
      itemTitle: item ? item.getField("title") : parent.getField("title"),
      attachmentKey: att.key,
      skippedFields,
      libraryID,
    };
  };

  const hTag = async (ctx) => {
    if (ctx.method !== "POST") throw new ABError(400, "bad_request", "POST JSON {itemKey, tag, action: 'add'|'remove', library?}");
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    let item = await findItem(libraryID, data.itemKey || data.key);
    let tag = String(data.tag || "").trim();
    if (!tag) throw new ABError(400, "bad_request", "'tag' is required");
    let action = (data.action || "add").toLowerCase();
    let changed = false;
    if (action === "add") {
      if (!item.hasTag(tag)) {
        item.addTag(tag, data.type === 1 ? 1 : 0);
        changed = true;
      }
    } else if (action === "remove") {
      if (item.hasTag(tag)) {
        item.removeTag(tag);
        changed = true;
      }
    } else {
      throw new ABError(400, "bad_request", "action must be 'add' or 'remove'");
    }
    if (changed) await item.saveTx();
    return { key: item.key, tag, action, changed, tags: item.getTags().map((t) => t.tag) };
  };

  // ---------- route table ----------
  const ROUTES = [
    { path: "/zotero-agent-mcp/ping", scope: null, handler: hPing },
    { path: "/zotero-agent-mcp/libraries", scope: "read", handler: hLibraries },
    { path: "/zotero-agent-mcp/collections", scope: "read", handler: hCollections },
    { path: "/zotero-agent-mcp/search", scope: "read", handler: hSearch },
    { path: "/zotero-agent-mcp/items/recent", scope: "read", handler: hRecent },
    { path: "/zotero-agent-mcp/item/:key", scope: "read", handler: hItem },
    { path: "/zotero-agent-mcp/item/:key/fulltext", scope: "fulltext", handler: hFulltext },
    { path: "/zotero-agent-mcp/item/:key/annotations", scope: "annotations", handler: hAnnotations },
    { path: "/zotero-agent-mcp/item/:key/children", scope: "read", handler: hChildren },
    { path: "/zotero-agent-mcp/item/:key/cite", scope: "export", handler: hCite },
    { path: "/zotero-agent-mcp/item/:key/file", scope: "files", handler: hFile },
    { path: "/zotero-agent-mcp/item", scope: "write", handler: hCreateItem, methods: ["POST"] },
    { path: "/zotero-agent-mcp/note", scope: "write", handler: hNote, methods: ["POST"] },
    { path: "/zotero-agent-mcp/tag", scope: "write", handler: hTag, methods: ["POST"] },
  ];
  this.ROUTES = ROUTES;

  // ---------- lifecycle ----------
  this.startup = async function ({ id, version, rootURI, bridgeSource }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this._bridgeSource = bridgeSource;
    Zotero.AgentMCP = AgentMCP; // expose for prefs.js and debugging
    seedDefaults();
    await migrateOldBranding();
    await restoreStableToken();

    for (let r of ROUTES) {
      let ep = makeEndpoint(r.scope, r.handler, { methods: r.methods });
      Zotero.Server.Endpoints[r.path] = ep;
      registeredEndpoints.push(r.path);
    }

    // Register the settings pane (auto-unregistered on plugin shutdown)
    Zotero.PreferencePanes.register({
      pluginID: id,
      src: rootURI + "prefs.xhtml",
      scripts: [rootURI + "prefs.js"],
      id: "zotero-agent-mcp-prefs",
      label: "Zotero-Agent-MCP",
    }).catch((e) => Zotero.logError(e));

    // Release MCP bridge files (deferred, low priority)
    releaseBridgeFiles().catch((e) => Zotero.logError(e));

    rotateAuditIfHuge().catch(() => {});

    Zotero.debug(`AgentMCP ${version}: ${ROUTES.length} endpoints registered on http://127.0.0.1:23119/zotero-agent-mcp/`);
  };

  this.shutdown = function () {
    for (let path of registeredEndpoints) {
      delete Zotero.Server.Endpoints[path];
    }
    registeredEndpoints = [];
    Zotero.debug("AgentMCP: endpoints unregistered");
  };
}();
