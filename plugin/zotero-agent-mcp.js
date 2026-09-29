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
  let exportTranslatorCache = new Map();

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
    // exposed for optimistic concurrency: pass back to POST /item/:key/update as `version`
    out.version = item.version;
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

  async function findItem(libraryID, key, opts = {}) {
    if (!key || !/^[A-Z0-9]{8}$/.test(String(key))) {
      throw new ABError(400, "bad_request", "item key must be an 8-character Zotero key like 'ABCD1234'");
    }
    let item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
    if (!item || (item.deleted && !opts.includeTrashed)) {
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
  // Extra export formats beyond bibliography/citation/bibtex, via installed
  // translators (labels verified against Zotero 10's installed translator set;
  // unknown labels fall through to the "unknown format" 400 below).
  const EXPORT_TRANSLATORS = {
    bibtex: "BibTeX",
    biblatex: "BibLaTeX",
    ris: "RIS",
    csljson: "CSL JSON",
    csv: "CSV",
    mods: "MODS",
    refer: "Refer/BibIX",
    tei: "TEI",
    wikipedia: "Wikipedia Citation Templates",
    marc: "MARC",
  };

  async function citeJSON(items, params) {
    let format = (params.get("format") || "bibliography").toLowerCase();
    if (!["bibliography", "citation", "bibtex"].includes(format) && !(format in EXPORT_TRANSLATORS)) {
      throw new ABError(400, "bad_request", "format must be bibliography | citation | bibtex | ris | csljson | csv | mods | refer | tei | wikipedia | biblatex | marc");
    }
    if (format !== "bibliography" && format !== "citation") {
      let label = format === "bibtex" ? "BibTeX" : EXPORT_TRANSLATORS[format];
      let text = await exportWithTranslator(items, label);
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

  async function exportWithTranslator(items, label) {
    let translatorID = exportTranslatorCache.get(label);
    if (!translatorID) {
      let all = await Zotero.Translators.getAll();
      let t = all.find((x) => x.label === label);
      if (!t) throw new ABError(400, "unknown_format", `Export translator '${label}' not installed`);
      translatorID = t.translatorID;
      exportTranslatorCache.set(label, translatorID);
    }
    let translation = new Zotero.Translate.Export();
    translation.setItems(items.slice());
    translation.setTranslator(translatorID);
    let done = new Promise((resolve) => {
      translation.setHandler("done", (obj, worked) => resolve(worked ? obj.string || "" : ""));
    });
    await translation.translate();
    let text = await done;
    if (!text) throw new ABError(500, "export_failed", `Export via '${label}' produced no output`);
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
    // Agent routing skill — released next to the bridge so agents can install it
    // (tools/install-skill.sh junctions it into the agent's skills directory).
    if (AgentMCP._skillSource) {
      let skillDir = PathUtils.join(dir, "skill");
      await IOUtils.makeDirectory(skillDir, { ignoreExisting: true });
      let skillDest = PathUtils.join(skillDir, "SKILL.md");
      let curSkill = null;
      try {
        curSkill = await IOUtils.readUTF8(skillDest);
      } catch (e) {}
      if (curSkill !== AgentMCP._skillSource) {
        await IOUtils.writeUTF8(skillDest, AgentMCP._skillSource);
      }
    }
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
    // `scope` may be a per-method map, e.g. { GET: "read", POST: "write" },
    // so one path can serve reads and writes under different scopes.
    if (scope && typeof scope === "object") {
      scope = scope[options.method] ?? null;
    }
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
  // POST JSON: {path?, title?, itemType?, fields?, creators?, collections?[], tags?[],
  //             mode? 'import'|'link', parentKey?, library?, recognize?}
  // With no `path`, creates a pure-metadata item (v0.5.0) — the common case for
  // literature ingest, where the agent has bibliographic data but no local file.
  async function resolveCollectionKeyOrName(libraryID, s) {
    // recursive=true so nested subcollections resolve by key/name too
    let cols = Zotero.Collections.getByLibrary(libraryID, true);
    let c = cols.find((x) => !x.deleted && (x.key === s || x.name === s));
    if (!c) {
      throw new ABError(404, "not_found", `No collection '${s}' in library ${libraryID} (match by collection key or exact name)`);
    }
    return c;
  }

  // Shared metadata appliers, used by item creation and update alike.

  // `fields` maps Zotero field names to values; invalid/inapplicable names are
  // skipped, not fatal, and reported via the returned array.
  function applyItemFields(item, fields) {
    let skipped = [];
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) return skipped;
    for (let [fieldName, value] of Object.entries(fields)) {
      if (fieldName === "title" || value === undefined || value === null || value === "") continue;
      try {
        item.setField(String(fieldName), String(value));
      } catch (e) {
        skipped.push(String(fieldName));
      }
    }
    return skipped;
  }

  // `creators` accepts Zotero creator JSON: {creatorType?, name} for single-field
  // names (common for Chinese authors) or {creatorType?, firstName, lastName}.
  function applyItemCreators(item, creators) {
    if (!Array.isArray(creators)) return;
    let out = [];
    for (let c of creators.slice(0, 200)) {
      if (!c || typeof c !== "object") continue;
      let creatorType = String(c.creatorType || "author");
      if (!Zotero.CreatorTypes.getID(creatorType)) creatorType = "author";
      if (c.name) {
        out.push({ creatorType, name: String(c.name), fieldMode: 1 });
      } else if (c.lastName || c.firstName) {
        out.push({ creatorType, lastName: String(c.lastName || ""), firstName: String(c.firstName || ""), fieldMode: 0 });
      }
    }
    if (out.length) item.setCreators(out);
  }

  function applyItemTags(item, tags) {
    if (!Array.isArray(tags)) return;
    for (let t of tags.slice(0, 50)) {
      let tag = String(t || "").trim();
      if (tag && !item.hasTag(tag)) item.addTag(tag);
    }
  }

  async function applyItemCollections(item, libraryID, collections) {
    if (!Array.isArray(collections) || !collections.length) return;
    let collectionIDs = [];
    for (let c of collections.slice(0, 50)) {
      let col = await resolveCollectionKeyOrName(libraryID, String(c));
      collectionIDs.push(col.id);
    }
    item.setCollections(collectionIDs);
  }

  function resolveLocalPath(path) {
    path = String(path || "").trim();
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
    return file;
  }

  const hCreateItem = async (ctx) => {
    if (ctx.method !== "POST") {
      throw new ABError(400, "bad_request", "POST JSON {path?, title?, itemType?, fields?, creators?, collections?, tags?, mode?, parentKey?, library?, recognize?}");
    }
    let data = ctx.data || {};
    let path = String(data.path || "").trim();
    let file = path ? resolveLocalPath(path) : null;
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);

    if (data.parentKey && !file) {
      throw new ABError(400, "bad_request", "'parentKey' requires 'path' (attaches a file to an existing item — for metadata-less creation leave parentKey out)");
    }

    let mode = (data.mode || "import").toLowerCase();
    if (!["import", "link"].includes(mode)) {
      throw new ABError(400, "bad_request", "mode must be 'import' (copy into Zotero storage) or 'link' (reference the original path)");
    }

    let fileName = file ? file.leafName : "";
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
      skippedFields = applyItemFields(item, data.fields);
      applyItemCreators(item, data.creators);
      applyItemTags(item, data.tags);
      await applyItemCollections(item, libraryID, data.collections);
      await item.saveTx();
    }

    let att = null;
    if (file) {
      let parentItemID = parent ? parent.id : item.id;
      let attOpts = {
        file,
        parentItemID,
        title: data.attachmentTitle ? String(data.attachmentTitle) : undefined,
      };
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
    }

    if (att && data.recognize) {
      try {
        Zotero.RecognizeDocument.recognizeItems([att]);
      } catch (e) {
        Zotero.debug("AgentMCP: recognize failed: " + e);
      }
    }

    let out = {
      created: true,
      mode: file ? mode : "metadata",
      itemKey: item ? item.key : parent.key,
      itemTitle: item ? item.getField("title") : parent.getField("title"),
      skippedFields,
      libraryID,
    };
    if (att) out.attachmentKey = att.key;
    return out;
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

  // Change an item's collection memberships in one save.
  // POST JSON: {collections: [key or exact name], mode?: 'replace'|'add'|'remove', library?}
  // mode 'replace' (default) sets the full membership list; empty array clears it.
  const hSetItemCollections = async (ctx) => {
    if (ctx.method !== "POST") {
      throw new ABError(400, "bad_request", "POST JSON {collections: [collection key or exact name], mode?: 'replace'|'add'|'remove', library?}");
    }
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    let item = await findItem(libraryID, ctx.pathParams.key);
    if (!item.isTopLevelItem()) {
      throw new ABError(400, "bad_request", "Only top-level items can be collection members (child notes/attachments cannot)");
    }
    let mode = String(data.mode || "replace").toLowerCase();
    if (!["replace", "add", "remove"].includes(mode)) {
      throw new ABError(400, "bad_request", "mode must be 'replace' (default), 'add' or 'remove'");
    }
    if (!Array.isArray(data.collections)) {
      throw new ABError(400, "bad_request", "'collections' must be an array of collection keys or exact names");
    }
    if (!data.collections.length && mode !== "replace") {
      throw new ABError(400, "bad_request", "'collections' must be non-empty unless mode is 'replace' (which clears membership)");
    }
    let seen = new Set();
    let ids = [];
    for (let c of data.collections.slice(0, 200)) {
      let col = await resolveCollectionKeyOrName(libraryID, String(c));
      if (!seen.has(col.id)) {
        seen.add(col.id);
        ids.push(col.id);
      }
    }
    // setCollections dedupes, accepts ids/keys, and no-ops when unchanged;
    // add/remove are computed here so the whole change is a single saveTx.
    let before = item.getCollections().slice().sort((a, b) => a - b).join();
    let current = item.getCollections();
    let final;
    if (mode === "replace") {
      final = ids;
    } else if (mode === "add") {
      let cur = new Set(current);
      final = current.concat(ids.filter((id) => !cur.has(id)));
    } else {
      final = current.filter((id) => !seen.has(id));
    }
    item.setCollections(final);
    let changed = item.getCollections().slice().sort((a, b) => a - b).join() !== before;
    if (changed) await item.saveTx();
    let collections = item.getCollections().map((id) => {
      let col = Zotero.Collections.get(id);
      return { key: col.key, name: col.name };
    });
    return { key: item.key, mode, changed, collections };
  };

  // ---------- collection helpers (v0.5.0) ----------
  async function findCollection(libraryID, key) {
    if (!key || !/^[A-Z0-9]{8}$/.test(String(key))) {
      throw new ABError(400, "bad_request", "collection key must be an 8-character Zotero key like 'ABCD1234'");
    }
    let col = await Zotero.Collections.getByLibraryAndKeyAsync(libraryID, key);
    if (!col || col.deleted) {
      throw new ABError(404, "not_found", `No collection '${key}' in library ${libraryID}`);
    }
    return col;
  }

  async function ensureLoaded(obj) {
    try {
      await obj.loadAllData();
    } catch (e) {}
    return obj;
  }

  const hCreateCollection = async (ctx) => {
    if (ctx.method !== "POST") throw new ABError(400, "bad_request", "POST JSON {name, parent?, library?}");
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    let name = String(data.name || "").trim();
    if (!name) throw new ABError(400, "bad_request", "'name' is required");
    let col = new Zotero.Collection();
    col.libraryID = libraryID;
    col.name = name;
    let parent = null;
    if (data.parent !== undefined && data.parent !== null && data.parent !== "") {
      parent = await resolveCollectionKeyOrName(libraryID, String(data.parent));
      if (parent.key === col.key) throw new ABError(400, "bad_request", "A collection cannot be its own parent");
      col.parentID = parent.id;
    }
    await col.saveTx();
    return { created: true, key: col.key, name: col.name, parentKey: parent ? parent.key : null, libraryID };
  };

  const hUpdateCollection = async (ctx) => {
    if (ctx.method !== "POST") throw new ABError(400, "bad_request", "POST JSON {name?, parent? (null = move to top), deleted?, library?}");
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    let col = await findCollection(libraryID, ctx.pathParams.key);
    if (data.name !== undefined && data.name !== null && String(data.name).trim()) {
      col.name = String(data.name).trim();
    }
    if (data.parent !== undefined) {
      if (data.parent === null || data.parent === false || data.parent === "") {
        col.parentID = false; // move to top level
      } else {
        let parent = await resolveCollectionKeyOrName(libraryID, String(data.parent));
        if (parent.key === col.key) throw new ABError(400, "bad_request", "A collection cannot be its own parent");
        col.parentID = parent.id;
      }
    }
    if (data.deleted !== undefined) {
      col.deleted = !!data.deleted;
    }
    try {
      await col.saveTx();
    } catch (e) {
      throw new ABError(400, "bad_request", `Could not update collection: ${e && e.message ? e.message : e}`);
    }
    return { key: col.key, name: col.name, parentKey: col.parentKey || null, deleted: !!col.deleted, libraryID };
  };

  const hDeleteCollection = async (ctx) => {
    if (ctx.method !== "POST") throw new ABError(400, "bad_request", "POST JSON {permanent?, library?}");
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    let col = await findCollection(libraryID, ctx.pathParams.key);
    let permanent = !!data.permanent;
    if (permanent) {
      await col.eraseTx(); // member items are only unfiled, never deleted
    } else {
      col.deleted = true;
      await col.saveTx();
    }
    return { key: col.key, deleted: true, permanent, libraryID };
  };

  const hSearchCollections = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let q = (ctx.params.get("q") || "").trim().toLowerCase();
    if (!q) throw new ABError(400, "bad_request", "Missing 'q' query parameter");
    let cols = Zotero.Collections.getByLibrary(libraryID, true).filter((c) => !c.deleted);
    let byID = new Map(cols.map((c) => [c.id, c]));
    function pathOf(c) {
      let parts = [];
      let cur = c;
      while (cur) {
        parts.unshift(cur.name);
        cur = cur.parentID ? byID.get(cur.parentID) : null;
      }
      return parts.join(" / ");
    }
    let matches = cols
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 50)
      .map((c) => ({ key: c.key, name: c.name, parentKey: c.parentKey || null, path: pathOf(c) }));
    return { query: q, total: matches.length, collections: matches };
  };

  const hCollectionItems = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    // accept an 8-char key or an exact collection name
    let col = /^[A-Z0-9]{8}$/.test(String(ctx.pathParams.key))
      ? await findCollection(libraryID, ctx.pathParams.key)
      : await resolveCollectionKeyOrName(libraryID, String(ctx.pathParams.key));
    await ensureLoaded(col);
    let limit = clampInt(ctx.params.get("limit"), 1, 100, 50);
    let items = col.getChildItems(false, false).filter((i) => !i.deleted && i.isRegularItem());
    return {
      key: col.key,
      name: col.name,
      total: items.length,
      items: await Promise.all(items.slice(0, limit).map((i) => itemToJSON(i))),
    };
  };

  // ---------- item update / delete / trash (v0.5.0) ----------
  const hUpdateItem = async (ctx) => {
    if (ctx.method !== "POST") {
      throw new ABError(400, "bad_request", "POST JSON {title?, fields?, creators?, tags?, collections?, note?, deleted?, version?, library?}");
    }
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    // includeTrashed so trashed items can be restored (deleted: false) or updated
    let item = await findItem(libraryID, ctx.pathParams.key, { includeTrashed: true });
    // `version` is accepted but informational only: Zotero assigns object versions
    // asynchronously after local saves (queued), so a freshly read version can
    // legitimately lag the current one and strict locking would false-positive.
    if (data.title !== undefined && data.title !== null && String(data.title).trim()) {
      item.setField("title", String(data.title));
    }
    let skippedFields = applyItemFields(item, data.fields);
    applyItemCreators(item, data.creators);
    if (Array.isArray(data.tags)) {
      // web-API PATCH semantics: a tags array replaces the full set
      for (let t of item.getTags()) item.removeTag(t.tag);
      applyItemTags(item, data.tags);
    }
    if (data.collections !== undefined && data.collections !== null) {
      if (!Array.isArray(data.collections)) throw new ABError(400, "bad_request", "'collections' must be an array of collection keys or exact names");
      if (!data.collections.length) item.setCollections([]); // empty array clears membership
      else await applyItemCollections(item, libraryID, data.collections);
    }
    if (data.note !== undefined && data.note !== null && item.isNote()) {
      item.setNote(String(data.note).slice(0, MAX_NOTE_CHARS));
    }
    if (data.deleted !== undefined) {
      item.deleted = !!data.deleted;
    }
    try {
      await item.saveTx();
    } catch (e) {
      throw new ABError(400, "bad_request", `Could not update item: ${e && e.message ? e.message : e}`);
    }
    return { key: item.key, version: item.version, deleted: !!item.deleted, skippedFields, libraryID };
  };

  const hDeleteItem = async (ctx) => {
    if (ctx.method !== "POST") throw new ABError(400, "bad_request", "POST JSON {permanent?, library?}");
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    // includeTrashed: already-trashed items can be deleted permanently from the trash
    let item = await findItem(libraryID, ctx.pathParams.key, { includeTrashed: true });
    let permanent = !!data.permanent;
    if (permanent) {
      await item.eraseTx();
    } else {
      item.deleted = true; // trash — recoverable via update {deleted: false} or Zotero UI
      await item.saveTx();
    }
    return { key: ctx.pathParams.key, deleted: true, permanent, libraryID };
  };

  const hTrash = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let limit = clampInt(ctx.params.get("limit"), 1, 100, 50);
    let rows = await Zotero.DB.queryAsync(
      `SELECT i.itemID AS itemID FROM items i
       JOIN deletedItems d USING (itemID)
       WHERE i.libraryID = ?
       ORDER BY d.dateDeleted DESC LIMIT ?`,
      [libraryID, limit]
    );
    let items = await Zotero.Items.getAsync(rows.map((r) => r.itemID));
    return {
      libraryID,
      items: await Promise.all(items.map((i) => itemToJSON(i))),
    };
  };

  const hAttachFile = async (ctx) => {
    if (ctx.method !== "POST") throw new ABError(400, "bad_request", "POST JSON {path, mode? ('import'|'link'), title?, recognize?, library?}");
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    let parent = await findItem(libraryID, ctx.pathParams.key);
    if (!parent.isRegularItem()) {
      throw new ABError(400, "bad_request", "Can only attach files to regular (top-level) items");
    }
    let file = resolveLocalPath(data.path);
    let mode = (data.mode || "import").toLowerCase();
    if (!["import", "link"].includes(mode)) {
      throw new ABError(400, "bad_request", "mode must be 'import' or 'link'");
    }
    let att;
    try {
      att = mode === "link"
        ? await Zotero.Attachments.linkFromFile({ file, parentItemID: parent.id, title: data.title ? String(data.title) : undefined })
        : await Zotero.Attachments.importFromFile({ file, parentItemID: parent.id, title: data.title ? String(data.title) : undefined });
    } catch (e) {
      throw new ABError(415, "attach_failed", `Could not attach file: ${e && e.message ? e.message : e}`);
    }
    if (data.recognize) {
      try {
        Zotero.RecognizeDocument.recognizeItems([att]);
      } catch (e) {}
    }
    return { key: parent.key, attachmentKey: att.key, mode, libraryID };
  };

  const hAttachmentPath = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let item = await findItem(libraryID, ctx.pathParams.key);
    let att = await resolveAttachment(item);
    if (!att) throw new ABError(404, "no_attachment", "Item has no attachment to locate");
    let path = await att.getFilePathAsync();
    if (!path) throw new ABError(404, "file_missing", "Attachment file not found on disk");
    return { key: item.key, attachmentKey: att.key, path, contentType: att.attachmentContentType || null };
  };

  // ---------- tags (library-wide, v0.5.0) ----------
  const hTags = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let tags = await Zotero.Tags.getAll(libraryID);
    let out = tags
      .map((t) => (t && typeof t === "object" ? { tag: t.tag, type: t.type ?? null } : { tag: String(t), type: null }))
      .slice(0, 1000);
    return { libraryID, total: out.length, tags: out };
  };

  const hDeleteTags = async (ctx) => {
    if (ctx.method !== "POST") throw new ABError(400, "bad_request", "POST JSON {tags: [name, …] (max 50), library?}");
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    if (!Array.isArray(data.tags) || !data.tags.length) {
      throw new ABError(400, "bad_request", "'tags' must be a non-empty array of tag names");
    }
    let names = data.tags.slice(0, 50).map((t) => String(t || "").trim()).filter(Boolean);
    let tagIDs = names.map((n) => Zotero.Tags.getID(n)).filter((id) => !!id);
    if (tagIDs.length) {
      await Zotero.Tags.removeFromLibrary(libraryID, tagIDs);
    }
    return { libraryID, requested: names.length, deleted: tagIDs.length };
  };

  // ---------- saved searches (v0.5.0) ----------
  const hSearches = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let searches = await Zotero.Searches.getAll(libraryID);
    let out = [];
    for (let s of searches) {
      if (s.deleted) continue;
      out.push({ key: s.key, name: s.name, version: s.version });
    }
    return { libraryID, total: out.length, searches: out };
  };

  function validateSearchConditions(conditions) {
    if (!Array.isArray(conditions) || !conditions.length) {
      throw new ABError(400, "bad_request", "'conditions' must be a non-empty array of {condition, operator, value}");
    }
    return conditions.slice(0, 50).map((c) => ({
      condition: String(c.condition || ""),
      operator: String(c.operator || "contains"),
      value: String(c.value ?? ""),
    }));
  }

  const hCreateSearch = async (ctx) => {
    if (ctx.method !== "POST") throw new ABError(400, "bad_request", "POST JSON {name, conditions: [{condition, operator, value}], library?}");
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    let name = String(data.name || "").trim();
    if (!name) throw new ABError(400, "bad_request", "'name' is required");
    let conditions = validateSearchConditions(data.conditions);
    let s = new Zotero.Search();
    s.libraryID = libraryID;
    try {
      s.fromJSON({ name, conditions });
    } catch (e) {
      throw new ABError(400, "bad_request", `Invalid search conditions: ${e && e.message ? e.message : e}`);
    }
    await s.saveTx();
    return { created: true, key: s.key, name: s.name, libraryID };
  };

  // One path, two methods: GET lists saved searches, POST creates one.
  const hSearchesDispatch = async (ctx) => {
    if (ctx.method === "POST") return hCreateSearch(ctx);
    return hSearches(ctx);
  };

  const hUpdateSearch = async (ctx) => {
    if (ctx.method !== "POST") throw new ABError(400, "bad_request", "POST JSON {name?, conditions?, library?}");
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    let s = Zotero.Searches.getByLibraryAndKey(libraryID, ctx.pathParams.key);
    if (!s || s.deleted) throw new ABError(404, "not_found", `No saved search '${ctx.pathParams.key}' in library ${libraryID}`);
    await ensureLoaded(s);
    if (data.conditions !== undefined) {
      let conditions = validateSearchConditions(data.conditions);
      try {
        s.fromJSON({ name: String(data.name || s.name), conditions });
      } catch (e) {
        throw new ABError(400, "bad_request", `Invalid search conditions: ${e && e.message ? e.message : e}`);
      }
    } else if (data.name !== undefined && String(data.name).trim()) {
      s.name = String(data.name).trim();
    }
    await s.saveTx();
    return { key: s.key, name: s.name, version: s.version, libraryID };
  };

  const hDeleteSearch = async (ctx) => {
    if (ctx.method !== "POST") throw new ABError(400, "bad_request", "POST JSON {library?}");
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    let s = Zotero.Searches.getByLibraryAndKey(libraryID, ctx.pathParams.key);
    if (!s || s.deleted) throw new ABError(404, "not_found", `No saved search '${ctx.pathParams.key}' in library ${libraryID}`);
    await s.eraseTx();
    return { key: ctx.pathParams.key, deleted: true, libraryID };
  };

  const hRunSearch = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let s = Zotero.Searches.getByLibraryAndKey(libraryID, ctx.pathParams.key);
    if (!s || s.deleted) throw new ABError(404, "not_found", `No saved search '${ctx.pathParams.key}' in library ${libraryID}`);
    await ensureLoaded(s);
    let limit = clampInt(ctx.params.get("limit"), 1, 100, 50);
    let ids = await s.search();
    let items = (await Zotero.Items.getAsync(ids)).filter((i) => i.isRegularItem() && !i.deleted);
    return {
      key: s.key,
      name: s.name,
      total: items.length,
      items: await Promise.all(items.slice(0, limit).map((i) => itemToJSON(i))),
    };
  };

  // ---------- schema introspection (v0.5.0) ----------
  const hSchema = async (ctx) => {
    let itemType = ctx.params.get("itemType");
    if (!itemType) {
      return {
        itemTypes: Zotero.ItemTypes.getAll().map((t) => ({ itemType: t.name, localized: Zotero.ItemTypes.getLocalizedString(t.name) })),
      };
    }
    let typeID = Zotero.ItemTypes.getID(itemType);
    if (!typeID) throw new ABError(400, "bad_request", `Unknown itemType '${itemType}'`);
    let fields = Zotero.ItemFields.getItemTypeFields(typeID).map((fieldID) => ({
      field: Zotero.ItemFields.getName(fieldID),
      localized: Zotero.ItemFields.getLocalizedString(fieldID),
    }));
    let creatorTypes = Zotero.CreatorTypes.getTypesForItemType(typeID).map((c) =>
      typeof c === "string"
        ? { creatorType: c, localized: Zotero.CreatorTypes.getLocalizedString(c) }
        : { creatorType: c.name || c.creatorType, localized: c.localized || null }
    );
    return { itemType, fields, creatorTypes };
  };

  // ---------- versions / incremental sync (v0.5.0) ----------
  const hVersions = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let type = (ctx.params.get("type") || "items").toLowerCase();
    let since = clampInt(ctx.params.get("since"), 0, 1000000000, 0);
    let versions = {};
    if (type === "items") {
      let rows = await Zotero.DB.queryAsync("SELECT key, version FROM items WHERE libraryID=? AND version>?", [libraryID, since]);
      for (let r of rows) versions[r.key] = r.version;
    } else if (type === "collections") {
      let rows = await Zotero.DB.queryAsync("SELECT key, version FROM collections WHERE libraryID=? AND version>?", [libraryID, since]);
      for (let r of rows) versions[r.key] = r.version;
    } else if (type === "searches") {
      let rows = await Zotero.DB.queryAsync("SELECT key, version FROM savedSearches WHERE libraryID=? AND version>?", [libraryID, since]);
      for (let r of rows) versions[r.key] = r.version;
    } else if (type === "fulltext") {
      let rows = await Zotero.DB.queryAsync(
        "SELECT I.key, FI.version FROM fulltextItems FI JOIN items I USING (itemID) WHERE I.libraryID=?1 AND (?2=0 OR FI.version>?2)",
        [libraryID, since]
      );
      for (let r of rows) versions[r.key] = r.version;
    } else {
      throw new ABError(400, "bad_request", "type must be items | collections | searches | fulltext");
    }
    return {
      libraryID,
      type,
      since,
      libraryVersion: Zotero.Libraries.get(libraryID).clientVersion,
      total: Object.keys(versions).length,
      versions,
    };
  };

  // ---------- fulltext write (v0.5.0) ----------
  const hSetFulltext = async (ctx) => {
    if (ctx.method !== "POST") throw new ABError(400, "bad_request", "POST JSON {content, library?}");
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    let item = await findItem(libraryID, ctx.pathParams.key);
    let att = await resolveAttachment(item);
    if (!att || !att.isFileAttachment()) {
      throw new ABError(404, "no_attachment", "Item has no file attachment to index");
    }
    if (!Zotero.Fulltext.isCachedMIMEType(att.attachmentContentType)) {
      throw new ABError(415, "unsupported_type", `Content type '${att.attachmentContentType}' cannot hold a text index`);
    }
    let content = String(data.content ?? "");
    if (!content.length) throw new ABError(400, "bad_request", "'content' must be a non-empty string");
    // Same sequence the local API uses: bump library version, write cache, flush
    let library = Zotero.Libraries.get(libraryID);
    let newVersion = await Zotero.DB.executeTransaction(async () => library.incrementClientVersion());
    await Zotero.Fulltext.setItemContent(libraryID, att.key, { content }, newVersion);
    await Zotero.Fulltext.indexSyncedContent(att.id);
    return { key: item.key, attachmentKey: att.key, indexedChars: content.length, version: newVersion, libraryID };
  };

  // ---------- route table ----------
  const ROUTES = [
    { path: "/zotero-agent-mcp/ping", scope: null, handler: hPing },
    { path: "/zotero-agent-mcp/libraries", scope: "read", handler: hLibraries },
    { path: "/zotero-agent-mcp/collections", scope: "read", handler: hCollections },
    { path: "/zotero-agent-mcp/collections/search", scope: "read", handler: hSearchCollections },
    { path: "/zotero-agent-mcp/collection/:key/items", scope: "read", handler: hCollectionItems },
    { path: "/zotero-agent-mcp/search", scope: "read", handler: hSearch },
    { path: "/zotero-agent-mcp/items/recent", scope: "read", handler: hRecent },
    { path: "/zotero-agent-mcp/items/trash", scope: "read", handler: hTrash },
    { path: "/zotero-agent-mcp/item/:key", scope: "read", handler: hItem },
    { path: "/zotero-agent-mcp/item/:key/fulltext", scope: "fulltext", handler: hFulltext },
    { path: "/zotero-agent-mcp/item/:key/fulltext/set", scope: "fulltext", handler: hSetFulltext, methods: ["POST"] },
    { path: "/zotero-agent-mcp/item/:key/annotations", scope: "annotations", handler: hAnnotations },
    { path: "/zotero-agent-mcp/item/:key/children", scope: "read", handler: hChildren },
    { path: "/zotero-agent-mcp/item/:key/cite", scope: "export", handler: hCite },
    { path: "/zotero-agent-mcp/item/:key/file", scope: "files", handler: hFile },
    { path: "/zotero-agent-mcp/item/:key/path", scope: "files", handler: hAttachmentPath },
    { path: "/zotero-agent-mcp/item/:key/update", scope: "write", handler: hUpdateItem, methods: ["POST"] },
    { path: "/zotero-agent-mcp/item/:key/delete", scope: "write", handler: hDeleteItem, methods: ["POST"] },
    { path: "/zotero-agent-mcp/item/:key/attach", scope: "write", handler: hAttachFile, methods: ["POST"] },
    { path: "/zotero-agent-mcp/item", scope: "write", handler: hCreateItem, methods: ["POST"] },
    { path: "/zotero-agent-mcp/item/:key/collections", scope: "write", handler: hSetItemCollections, methods: ["POST"] },
    { path: "/zotero-agent-mcp/collection", scope: "write", handler: hCreateCollection, methods: ["POST"] },
    { path: "/zotero-agent-mcp/collection/:key/update", scope: "write", handler: hUpdateCollection, methods: ["POST"] },
    { path: "/zotero-agent-mcp/collection/:key/delete", scope: "write", handler: hDeleteCollection, methods: ["POST"] },
    { path: "/zotero-agent-mcp/note", scope: "write", handler: hNote, methods: ["POST"] },
    { path: "/zotero-agent-mcp/tag", scope: "write", handler: hTag, methods: ["POST"] },
    { path: "/zotero-agent-mcp/tags", scope: "read", handler: hTags },
    { path: "/zotero-agent-mcp/tags/delete", scope: "write", handler: hDeleteTags, methods: ["POST"] },
    { path: "/zotero-agent-mcp/searches", scope: { GET: "read", POST: "write" }, handler: hSearchesDispatch, methods: ["GET", "POST"] },
    { path: "/zotero-agent-mcp/search/:key/items", scope: "read", handler: hRunSearch },
    { path: "/zotero-agent-mcp/search/:key/update", scope: "write", handler: hUpdateSearch, methods: ["POST"] },
    { path: "/zotero-agent-mcp/search/:key/delete", scope: "write", handler: hDeleteSearch, methods: ["POST"] },
    { path: "/zotero-agent-mcp/schema", scope: "read", handler: hSchema },
    { path: "/zotero-agent-mcp/versions", scope: "read", handler: hVersions },
  ];
  this.ROUTES = ROUTES;

  // ---------- lifecycle ----------
  this.startup = async function ({ id, version, rootURI, bridgeSource, skillSource }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this._bridgeSource = bridgeSource;
    this._skillSource = skillSource;
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
