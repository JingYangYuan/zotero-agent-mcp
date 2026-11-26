/* Zotero-Agent-MCP — core module
 * Loaded as a subscript of bootstrap.js with ctx = { Zotero, rootURI, id, version }.
 * Registers HTTP endpoints on Zotero.Server (127.0.0.1:23119) under /zotero-agent-mcp/,
 * guarded by a bearer token, per-scope switches, library allowlist,
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
    audit: true,
    autoSync: true,
  };

  let registeredEndpoints = [];
  let bridgeReleasedVersion = null;
  let exportTranslatorCache = new Map();
  // Resolved once the deferred startup maintenance (token reconciliation, file
  // release, audit rotation) has finished. Handlers await it so a request that
  // lands in the first few milliseconds never races the token restore.
  let readyPromise = Promise.resolve();
  let nodePathCache;
  let clientsCache = null;

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
    // Refresh the released snippets and rewrite every client config with the new token.
    releaseBridgeFiles()
      .then(() => AgentMCP.autoSyncClients())
      .catch((e) => Zotero.logError(e));
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

  // Rotating on every launch meant a stat() (and a possible move) on the startup
  // path. Once a day is plenty for a 5 MB cap.
  async function maybeRotateAudit() {
    let last = String(getPref("lastAuditRotate") || "");
    let today = new Date().toISOString().slice(0, 10);
    if (last === today) return;
    await rotateAuditIfHuge();
    setPref("lastAuditRotate", today);
  }
  this.maybeRotateAudit = maybeRotateAudit;

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
  const COMPACT_ITEM_FIELDS = new Set([
    "title", "shortTitle", "creators", "date", "publicationTitle", "bookTitle",
    "proceedingsTitle", "DOI", "ISBN", "url", "tags", "collections", "parentItem",
  ]);

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
      if (opts.compact && !COMPACT_ITEM_FIELDS.has(k)) continue;
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
    if (q) s.addCondition(mode, "contains", q);
    if (tag) s.addCondition("tag", "is", tag);
    if (itemType) s.addCondition("itemType", "is", itemType);
    return s.search();
  }

  function clampInt(v, min, max, def) {
    let n = parseInt(v, 10);
    if (isNaN(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  function boolParam(v) {
    return v === true || v === "true" || v === "1" || v === 1;
  }

  function parseLimit(params, def = 25, max = 500, compact = false) {
    let cap = compact ? Math.max(max, 1000) : max;
    return clampInt(params.get("limit"), 1, cap, def);
  }

  function parseOffset(params) {
    return clampInt(params.get("offset"), 0, 10000000, 0);
  }

  function pageMeta(total, offset, limit, pageLen) {
    let nextOffset = offset + pageLen < total ? offset + pageLen : null;
    return {
      total,
      offset,
      limit,
      hasMore: nextOffset !== null,
      nextOffset,
    };
  }

  function sortItemsDesc(items) {
    return items.sort((a, b) => {
      let dc = String(b.dateModified || "").localeCompare(String(a.dateModified || ""));
      return dc !== 0 ? dc : String(b.key || "").localeCompare(String(a.key || ""));
    });
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
        let fullText = htmlToText(n.getNote());
        out.notes.push({
          key: n.key,
          text: fullText.slice(0, 2000),
          totalChars: fullText.length,
          truncated: fullText.length > 2000,
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
    let directByCol = new Map();
    try {
      let rows = await Zotero.DB.queryAsync(
        `SELECT ci.collectionID AS cid, ci.itemID AS iid
         FROM collectionItems ci
         JOIN items i USING (itemID)
         JOIN itemTypes it USING (itemTypeID)
         WHERE i.libraryID = ?
           AND it.typeName NOT IN ('note', 'attachment', 'annotation')
           AND i.itemID NOT IN (SELECT itemID FROM deletedItems)`,
        [libraryID]
      );
      for (let r of rows) {
        let cid = Number(r.cid);
        if (!directByCol.has(cid)) directByCol.set(cid, new Set());
        directByCol.get(cid).add(Number(r.iid));
      }
    } catch (e) {}
    let byParent = new Map();
    let info = new Map();
    for (let c of cols) {
      if (c.deleted) continue;
      info.set(c.id, c);
      let p = c.parentID || 0;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(c);
    }
    let recCache = new Map();
    function recursiveItems(cid) {
      if (recCache.has(cid)) return recCache.get(cid);
      let merged = new Set(directByCol.get(cid) || []);
      recCache.set(cid, merged);
      for (let child of byParent.get(cid) || []) {
        for (let iid of recursiveItems(child.id)) merged.add(iid);
      }
      return merged;
    }
    function build(cid) {
      return (byParent.get(cid) || [])
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map((c) => {
          let direct = directByCol.get(c.id);
          return {
            key: c.key,
            name: c.name,
            itemCount: direct ? direct.size : 0,
            totalItemCount: recursiveItems(c.id).size,
            children: build(c.id),
          };
        });
    }
    return build(0);
  }

  // ---------- recent ----------
  async function recentItems(libraryID, limit, offset = 0, unfiled = false) {
    let unfiledClause = unfiled
      ? "AND i.itemID NOT IN (SELECT itemID FROM collectionItems)"
      : "";
    let countRows = await Zotero.DB.queryAsync(
      `SELECT COUNT(*) AS cnt FROM items i
       JOIN itemTypes it USING (itemTypeID)
       WHERE i.libraryID = ?
         AND it.typeName NOT IN ('note', 'attachment', 'annotation')
         AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
         ${unfiledClause}`,
      [libraryID]
    );
    let total = Number(countRows[0]?.cnt || 0);
    let rows = await Zotero.DB.queryAsync(
      `SELECT i.itemID AS itemID FROM items i
       JOIN itemTypes it USING (itemTypeID)
       WHERE i.libraryID = ?
         AND it.typeName NOT IN ('note', 'attachment', 'annotation')
         AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
         ${unfiledClause}
       ORDER BY i.dateModified DESC, i.key DESC LIMIT ? OFFSET ?`,
      [libraryID, limit, offset]
    );
    let ids = rows.map((r) => r.itemID);
    return { total, items: await Zotero.Items.getAsync(ids) };
  }

  // ---------- paths & small file helpers ----------
  function bridgeDir() {
    return PathUtils.join(Zotero.DataDirectory.dir, "zotero-agent-mcp");
  }
  this.bridgeDir = bridgeDir;
  this.bridgePath = function () {
    return PathUtils.join(bridgeDir(), "zotero-agent-mcp.mjs");
  };
  this.skillPath = function () {
    return joinPath(bridgeDir(), "skill", "SKILL.md");
  };
  function dataFilePath(name) {
    return PathUtils.join(bridgeDir(), name);
  }
  this.dataFilePath = dataFilePath;

  function baseUrl() {
    let port = 23119;
    try {
      port = Zotero.Server.port || 23119;
    } catch (e) {}
    return `http://127.0.0.1:${port}${BASE}`;
  }
  this.baseUrl = baseUrl;

  async function readTextIfExists(path) {
    try {
      return await IOUtils.readUTF8(path);
    } catch (e) {
      return null;
    }
  }
  // Every startup used to rewrite the bridge, the skill, the version stamp and the
  // config file. Comparing first turns that into reads only, so a normal launch
  // does zero writes in the data directory.
  async function writeIfChanged(path, content) {
    let cur = await readTextIfExists(path);
    if (cur === content) return false;
    await IOUtils.writeUTF8(path, content);
    return true;
  }

  // ---------- child processes (optional capability) ----------
  let subprocessModule;
  function getSubprocess() {
    if (subprocessModule !== undefined) return subprocessModule;
    subprocessModule = null;
    try {
      let m = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
      subprocessModule = m.Subprocess || null;
    } catch (e) {
      Zotero.debug("AgentMCP: Subprocess module unavailable: " + e);
    }
    return subprocessModule;
  }
  this.processesAvailable = () => !!getSubprocess();

  async function runProcess(command, args, timeoutMs = 10000) {
    let Subprocess = getSubprocess();
    if (!Subprocess) return null;
    let proc;
    try {
      proc = await Subprocess.call({
        command,
        arguments: args || [],
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      return { code: -1, stdout: "", stderr: String((e && e.message) || e) };
    }
    const readPipe = async (pipe) => {
      if (!pipe) return "";
      try {
        if (typeof pipe.readString === "function") return await pipe.readString();
        if (typeof pipe.read === "function") {
          let bytes = [];
          for (;;) {
            let chunk = await pipe.read();
            if (!chunk || !chunk.length) break;
            bytes.push(...chunk);
          }
          return new TextDecoder().decode(new Uint8Array(bytes));
        }
      } catch (e) {
        return "";
      }
      return "";
    };
    let timer = null;
    let timedOut = false;
    let work = (async () => {
      let stdout = await readPipe(proc.stdout);
      let stderr = await readPipe(proc.stderr);
      let { exitCode } = await proc.wait();
      return { code: exitCode, stdout, stderr };
    })();
    let guard = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve({ code: -1, stdout: "", stderr: `timed out after ${timeoutMs}ms` });
      }, timeoutMs);
    });
    let result = await Promise.race([work, guard]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      try {
        proc.kill();
      } catch (e) {}
    }
    return result;
  }
  this.runProcess = runProcess;

  async function nodePath() {
    if (nodePathCache !== undefined) return nodePathCache;
    nodePathCache = "";
    let exe = Zotero.isWin ? "node.exe" : "node";
    let dirs = [];
    let home = homeDirPath();
    if (Zotero.isWin) {
      let pathEnv = envVar("PATH");
      if (pathEnv) {
        for (let seg of pathEnv.split(";")) {
          let d = seg.trim().replace(/^"+|"+$/g, "");
          if (d) dirs.push(d);
        }
      }
      let localApp = envVar("LOCALAPPDATA") || specialDir("LocalAppData", ["AppData", "Local"]);
      let progFiles = envVar("ProgramFiles") || "C:\\Program Files";
      let progFilesX86 = envVar("ProgramFiles(x86)") || "C:\\Program Files (x86)";
      dirs.push(joinPath(progFiles, "nodejs"), joinPath(progFilesX86, "nodejs"));
      if (localApp) dirs.push(joinPath(localApp, "Programs", "nodejs"));
      if (home) {
        for (let rel of [".volta/bin", "scoop/shims", ".bun/bin"]) {
          try {
            dirs.push(joinPath(home, rel));
          } catch (e) {}
        }
      }
    } else {
      // Zotero 10 has no Services.env, so probe the usual install locations instead of PATH.
      dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin");
      if (home) {
        for (let rel of [".local/bin", ".volta/bin", ".bun/bin", ".nvm/current/bin"]) {
          try {
            dirs.push(joinPath(home, rel));
          } catch (e) {}
        }
      }
    }
    let seen = new Set();
    for (let rawDir of dirs) {
      let dir = normalizePath(rawDir);
      if (!dir) continue;
      let key = Zotero.isWin ? dir.toLowerCase() : dir;
      if (seen.has(key)) continue;
      seen.add(key);
      let candidate;
      try {
        candidate = joinPath(dir, exe);
      } catch (e) {
        continue;
      }
      try {
        if (await IOUtils.exists(candidate)) {
          nodePathCache = candidate;
          break;
        }
      } catch (e) {}
    }
    if (!nodePathCache) {
      // Not found — fall back to the bare command name and let the client's PATH resolve it.
      nodePathCache = Zotero.isWin ? "node.exe" : "node";
    }
    return nodePathCache;
  }
  this.nodePath = nodePath;
  this.nodeFound = async () => {
    let p = await nodePath();
    try {
      return await IOUtils.exists(p);
    } catch (e) {
      return false;
    }
  };

  // ---------- client registry (read-only) ----------
  // Zotero 10 (Firefox 140) dropped Services.env, and PathUtils.homeDir is not
  // exposed here, so home detection tries the sources Zotero itself relies on.
  let homeDirCache;
  let homeDirSource = "";
  function homeDirPath() {
    if (homeDirCache !== undefined) return homeDirCache;
    let sources = [
      ["zotero/osfile.mjs", () => ChromeUtils.importESModule("chrome://zotero/content/osfile.mjs").OS.Constants.Path.homeDir],
      ["FileUtils", () => ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs").FileUtils.getDir("Home", []).path],
      ["dirsvc", () => Services.dirsvc.get("Home", Components.interfaces.nsIFile).path],
      ["PathUtils", () => PathUtils.homeDir],
      ["OS", () => OS.Constants.Path.homeDir],
    ];
    homeDirCache = "";
    for (let [name, get] of sources) {
      try {
        let v = get();
        if (v) {
          homeDirCache = String(v).replace(/[\\/]+$/, "");
          homeDirSource = name;
          break;
        }
      } catch (e) {}
    }
    if (!homeDirCache) Zotero.debug("AgentMCP: could not resolve the home directory");
    return homeDirCache;
  }
  this.homeDir = homeDirPath;
  this.homeDirSource = () => homeDirSource;
  function envVar(name) {
    try {
      let env = Components.classes["@mozilla.org/process/environment;1"].getService(
        Components.interfaces.nsIEnvironment
      );
      if (env && env.exists(name)) return String(env.get(name) || "");
    } catch (e) {}
    return "";
  }
  function specialDir(key, fallbackParts) {
    try {
      let f = Services.dirsvc.get(key, Components.interfaces.nsIFile);
      if (f && f.path) return String(f.path);
    } catch (e) {}
    let home = homeDirPath();
    return home && fallbackParts && fallbackParts.length ? joinPath(home, ...fallbackParts) : "";
  }
  function normalizePath(p) {
    if (!p) return "";
    let s = String(p).trim();
    if (!s) return "";
    if (Zotero.isWin) {
      let unc = s.startsWith("\\\\") || s.startsWith("//");
      s = s.replace(/\//g, "\\");
      s = unc ? "\\\\" + s.slice(2).replace(/\\+/g, "\\") : s.replace(/\\+/g, "\\");
      if (s.length > 3 && s.endsWith("\\")) s = s.replace(/\\+$/, "");
      return s;
    }
    s = s.replace(/\/+/g, "/");
    if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
    return s;
  }
  this.normalizePath = normalizePath;
  // Gecko's PathUtils.join throws on some multi-segment components, so append one
  // segment at a time and fall back to string concatenation.
  function joinPath(base, ...parts) {
    let out = normalizePath(base);
    let sep = Zotero.isWin ? "\\" : "/";
    for (let part of parts) {
      for (let seg of String(part).split(/[\\/]+/).filter(Boolean)) {
        let joined = null;
        try {
          joined = PathUtils.join(out, seg);
        } catch (e) {}
        if (!joined) joined = out ? (out.endsWith(sep) ? out : out + sep) + seg : seg;
        out = joined;
      }
    }
    return normalizePath(out);
  }
  this.joinPath = joinPath;

  function parentDirPath(p) {
    let norm = normalizePath(p);
    if (!norm) return "";
    try {
      if (typeof PathUtils.parent === "function") return normalizePath(PathUtils.parent(norm));
    } catch (e) {}
    let idx = Math.max(norm.lastIndexOf("/"), norm.lastIndexOf("\\"));
    if (idx > 0) {
      let parent = norm.slice(0, idx);
      if (Zotero.isWin && /^[A-Za-z]:$/.test(parent)) return parent + "\\";
      return parent;
    }
    return norm;
  }

  function platformKey() {
    if (Zotero.isWin) return "win32";
    if (Zotero.isMac) return "darwin";
    return "linux";
  }
  function expandPath(p) {
    if (!p) return "";
    let s = String(p).trim();
    if (!s) return "";
    if (!Zotero.isWin && /^%(USERPROFILE|APPDATA|LOCALAPPDATA)%/i.test(s)) return "";
    if (s === "~") return normalizePath(homeDirPath());
    if (s.startsWith("~/") || s.startsWith("~\\")) {
      let home = homeDirPath();
      s = home ? joinPath(home, s.slice(2)) : s.slice(2);
    }
    s = s.replace(/%([A-Za-z_]+)%/g, (m, name) => {
      if (/^HOME$/i.test(name)) return homeDirPath() || m;
      if (/^USERPROFILE$/i.test(name)) return envVar("USERPROFILE") || homeDirPath() || m;
      if (/^APPDATA$/i.test(name)) {
        return envVar("APPDATA") || specialDir("AppData", ["AppData", "Roaming"]) || m;
      }
      if (/^LOCALAPPDATA$/i.test(name)) {
        return envVar("LOCALAPPDATA") || specialDir("LocalAppData", ["AppData", "Local"]) || m;
      }
      return envVar(name) || m;
    });
    if (Zotero.isWin && (/^\/[^/]/.test(s) || /%[A-Za-z_]+%/.test(s))) return "";
    return normalizePath(s);
  }
  this.expandPath = expandPath;

  function parseRegistry(text) {
    try {
      let r = JSON.parse(String(text || "{}"));
      return r && Array.isArray(r.clients) ? r.clients.filter((c) => c && c.id) : [];
    } catch (e) {
      Zotero.debug("AgentMCP: clients registry parse failed: " + e);
      return [];
    }
  }

  async function loadClients(force) {
    if (clientsCache && !force) return clientsCache;
    let builtin = parseRegistry(AgentMCP._clientsSource || "{}");
    let localText = await readTextIfExists(dataFilePath("clients.local.json"));
    let local = localText ? parseRegistry(localText) : [];
    let map = new Map();
    for (let c of builtin) map.set(c.id, c);
    for (let c of local) map.set(c.id, Object.assign({}, map.get(c.id) || {}, c));
    clientsCache = Array.from(map.values()).map((c) =>
      Object.assign({ key: "zotero-agent", format: "json-mcpServers", prefer: "node" }, c)
    );
    return clientsCache;
  }
  this.clients = (force) => loadClients(force);

  function clientPaths(c) {
    let list = (c.paths && (c.paths[platformKey()] || c.paths.all)) || [];
    return list.map(expandPath).filter(Boolean);
  }
  function clientDetectPaths(c) {
    let list = c.detectPaths || (c.paths && c.paths[platformKey()]) || [];
    return list.map(expandPath).filter(Boolean);
  }

  // Pull the token out of a client entry so stale configs can be flagged.
  function entryToken(entry) {
    if (!entry || typeof entry !== "object") return "";
    let env = (entry.env && entry.env.ZOTERO_AGENT_TOKEN) || (entry.environment && entry.environment.ZOTERO_AGENT_TOKEN) || "";
    if (env) return String(env);
    let args = Array.isArray(entry.args) ? entry.args : Array.isArray(entry.command) ? entry.command : [];
    for (let i = 0; i < args.length; i++) {
      let a = String(args[i]);
      if (a === "--token" && args[i + 1]) return String(args[i + 1]);
      if (a.startsWith("--token=")) return a.slice("--token=".length);
    }
    return "";
  }

  function jsonEntryContainer(doc, format) {
    if (!doc || typeof doc !== "object") return null;
    if (format === "json-vscode-servers") return doc.servers || null;
    if (format === "json-opencode") return doc.mcp || null;
    // ZCode nests its MCP servers one level deeper: {"mcp": {"servers": {...}}}
    if (format === "json-zcode") return (doc.mcp && doc.mcp.servers) || null;
    if (format === "json-amp") return doc["amp.mcpServers"] || null;
    return doc.mcpServers || null;
  }

  async function clientStatus(c) {
    let paths = clientPaths(c);
    let detect = clientDetectPaths(c);
    let detected = false;
    for (let p of detect.concat(paths)) {
      try {
        if (await IOUtils.exists(p)) {
          detected = true;
          break;
        }
      } catch (e) {}
    }
    let out = {
      id: c.id,
      label: c.label || c.id,
      note: c.note || "",
      format: c.format,
      prefer: c.prefer || "node",
      skillDir: expandPath(c.skillDir || ""),
      detected,
      path: "",
      pathExists: false,
      configured: false,
      tokenMatch: null,
      error: null,
    };
    let existing = null;
    for (let p of paths) {
      try {
        if (await IOUtils.exists(p)) {
          existing = p;
          break;
        }
      } catch (e) {}
    }
    if (!existing) {
      out.path = paths[0] || "";
      return out;
    }
    out.path = existing;
    out.pathExists = true;
    let current = String(getPref("token") || "");
    try {
      let stat = await IOUtils.stat(existing);
      if (stat.size > 4 * 1024 * 1024) {
        // Very large profiles (~/.claude.json) — avoid a full parse, scan for the key.
        let text = await IOUtils.readUTF8(existing);
        out.configured = new RegExp(`"${c.key}"\\s*:`).test(text);
        return out;
      }
      let text = (await IOUtils.readUTF8(existing)).replace(/^\uFEFF/, "");
      if (c.format === "toml-codex") {
        let headerRe = tomlHeaderRe(c.key);
        let mainRe = new RegExp(
          `^\\[mcp_servers\\."?${c.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\]\\s*$`
        );
        let inTarget = false;
        let lines = [];
        for (let line of text.split(/\r?\n/)) {
          if (/^\s*\[/.test(line)) {
            let trimmed = line.trim();
            if (mainRe.test(trimmed)) out.configured = true;
            inTarget = headerRe.test(trimmed);
            continue;
          }
          if (inTarget) lines.push(line);
        }
        if (out.configured) {
          let sec = lines.join("\n");
          let tok = /ZOTERO_AGENT_TOKEN\s*=\s*"([^"]*)"/.exec(sec) || /"--token"\s*,\s*"([^"]*)"/.exec(sec);
          if (tok) out.tokenMatch = tok[1] === current;
        }
        return out;
      }
      let doc;
      try {
        doc = JSON.parse(text);
      } catch (e) {
        out.configured = new RegExp(`"${c.key}"\\s*:`).test(text);
        out.error = out.configured ? null : "JSON 无法解析";
        return out;
      }
      let container = jsonEntryContainer(doc, c.format);
      let entry = container ? container[c.key] : null;
      out.configured = !!entry;
      if (entry) {
        let tok = entryToken(entry);
        if (tok) out.tokenMatch = tok === current;
      }
      return out;
    } catch (e) {
      out.error = String((e && e.message) || e);
      return out;
    }
  }
  this.clientStatus = clientStatus;

  async function allClientStatus(force) {
    let clients = await loadClients(force);
    let out = [];
    for (let c of clients) out.push(await clientStatus(c));
    return out;
  }
  this.clientStatuses = allClientStatus;

  // ---------- config snippets ----------
  async function serverEntry(variant) {
    let token = String(getPref("token") || "");
    let url = baseUrl();
    if (variant === "npx") {
      let args = ["--prefer-offline", "-y", "zotero-agent-mcp", "--token", token];
      if (url !== "http://127.0.0.1:23119/zotero-agent-mcp") args.push("--url", url);
      return { type: "stdio", command: "npx", args, env: {} };
    }
    let node = await nodePath();
    return {
      type: "stdio",
      command: node,
      args: [AgentMCP.bridgePath()],
      env: { ZOTERO_AGENT_URL: url, ZOTERO_AGENT_TOKEN: token },
    };
  }
  this.serverEntry = serverEntry;

  function tomlSnippet(entry) {
    let lines = [`[mcp_servers.zotero-agent]`, `command = ${JSON.stringify(entry.command)}`];
    lines.push(`args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`);
    lines.push(`startup_timeout_sec = 20`);
    let env = Object.entries(entry.env || {});
    if (env.length) {
      lines.push("", `[mcp_servers.zotero-agent.env]`);
      for (let [k, v] of env) lines.push(`${k} = ${JSON.stringify(v)}`);
    }
    return lines.join("\n");
  }

  async function clientSnippet(client, variant) {
    let entry = await serverEntry(variant || client.prefer || "node");
    if (client.format === "toml-codex") return tomlSnippet(entry);
    if (client.format === "json-opencode") {
      let doc = {
        $schema: "https://opencode.ai/config.json",
        mcp: {
          "zotero-agent": {
            type: "local",
            command: [entry.command, ...entry.args],
            environment: entry.env,
            enabled: true,
          },
        },
      };
      return JSON.stringify(doc, null, 2);
    }
    if (client.format === "json-vscode-servers") {
      return JSON.stringify({ servers: { "zotero-agent": entry } }, null, 2);
    }
    if (client.format === "json-zcode") {
      return JSON.stringify({ mcp: { servers: { "zotero-agent": entry } } }, null, 2);
    }
    if (client.format === "json-amp") {
      return JSON.stringify({ "amp.mcpServers": { "zotero-agent": entry } }, null, 2);
    }
    return JSON.stringify({ mcpServers: { "zotero-agent": entry } }, null, 2);
  }
  this.clientSnippet = clientSnippet;

  // ---------- writing client configs (merge-only, backed up, undoable) ----------
  // All formats are edited with surgical text splices so host-managed files
  // (~/.claude.json is multi-MB and rewritten by Claude Code itself) keep their
  // formatting; we only ever touch the "zotero-agent" entry.
  function skipWs(text, i) {
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
  }
  function scanJsonString(text, i) {
    if (text[i] !== '"') return -1;
    i++;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === '"') return i + 1;
      i++;
    }
    return -1;
  }
  function scanJsonValue(text, i) {
    i = skipWs(text, i);
    let ch = text[i];
    if (ch === '"') return scanJsonString(text, i);
    if (ch === "{" || ch === "[") {
      let depth = 0;
      while (i < text.length) {
        let c = text[i];
        if (c === '"') {
          i = scanJsonString(text, i);
          if (i < 0) return -1;
          continue;
        }
        if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
          depth--;
          if (depth === 0) return i + 1;
        }
        i++;
      }
      return -1;
    }
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
    return i;
  }
  function findMember(text, objStart, key) {
    let i = skipWs(text, objStart);
    if (text[i] !== "{") return null;
    i++;
    while (i < text.length) {
      i = skipWs(text, i);
      if (text[i] === "}") return null;
      if (text[i] !== '"') return null;
      let keyStart = i;
      let keyEnd = scanJsonString(text, i);
      if (keyEnd < 0) return null;
      let name;
      try {
        name = JSON.parse(text.slice(keyStart, keyEnd));
      } catch (e) {
        return null;
      }
      i = skipWs(text, keyEnd);
      if (text[i] !== ":") return null;
      let valueStart = skipWs(text, i + 1);
      let valueEnd = scanJsonValue(text, valueStart);
      if (valueEnd < 0) return null;
      if (name === key) return { keyStart, keyEnd, valueStart, valueEnd };
      i = skipWs(text, valueEnd);
      if (text[i] === ",") {
        i++;
        continue;
      }
      return null;
    }
    return null;
  }
  function jsonNodeAt(text, pathKeys) {
    let node = skipWs(text, 0);
    if (text[node] !== "{") return -1;
    for (let k of pathKeys) {
      let range = findMember(text, node, k);
      if (!range) return -1;
      node = skipWs(text, range.valueStart);
      if (text[node] !== "{") return -1;
    }
    return node;
  }
  function insertIntoObject(text, objStart, body) {
    let i = skipWs(text, objStart + 1);
    let empty = text[i] === "}";
    let insert = empty ? body : body + ", ";
    return text.slice(0, i) + insert + text.slice(i);
  }
  // Set/replace one entry. Returns the new text, or null when the container is missing.
  function jsonSetEntry(text, pathKeys, key, valueJson) {
    let node = jsonNodeAt(text, pathKeys);
    if (node < 0) return null;
    let existing = findMember(text, node, key);
    if (existing) {
      return text.slice(0, existing.valueStart) + valueJson + text.slice(existing.valueEnd);
    }
    return insertIntoObject(text, node, '"' + key + '": ' + valueJson);
  }
  // Create a missing container path and put the entry inside it.
  function jsonCreateEntry(text, pathKeys, key, valueJson) {
    let root = skipWs(text, 0);
    if (text[root] !== "{") return null;
    let value = "{" + JSON.stringify(key) + ": " + valueJson + "}";
    for (let i = pathKeys.length - 1; i >= 1; i--) {
      value = "{" + JSON.stringify(pathKeys[i]) + ": " + value + "}";
    }
    let member = pathKeys.length ? JSON.stringify(pathKeys[0]) + ": " + value : JSON.stringify(key) + ": " + valueJson;
    return insertIntoObject(text, root, member);
  }
  function jsonRemoveEntry(text, pathKeys, key) {
    let node = jsonNodeAt(text, pathKeys);
    if (node < 0) return text;
    let existing = findMember(text, node, key);
    if (!existing) return text;
    let start = existing.keyStart;
    let end = existing.valueEnd;
    let after = skipWs(text, end);
    if (text[after] === ",") {
      end = skipWs(text, after + 1);
      return text.slice(0, start) + text.slice(end);
    }
    // last member: drop the preceding comma instead
    let before = start - 1;
    while (before > node && /\s/.test(text[before])) before--;
    if (text[before] === ",") start = before;
    return text.slice(0, start) + text.slice(end);
  }
  function isParseableJson(text) {
    try {
      JSON.parse(text);
      return true;
    } catch (e) {
      return false;
    }
  }

  function tomlHeaderRe(key) {
    return new RegExp("^\\[mcp_servers\\.\"?" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\"?(\\.env)?\\]\\s*$");
  }
  function tomlStripSection(text, key) {
    let headerRe = tomlHeaderRe(key);
    let kept = [];
    let skipping = false;
    for (let line of text.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) {
        skipping = headerRe.test(line.trim());
        if (skipping) continue;
      }
      if (!skipping) kept.push(line);
    }
    return kept.join("\n").replace(/\n{3,}/g, "\n\n");
  }
  function tomlSetSection(text, key, entry) {
    let body = tomlStripSection(text, key).replace(/\s+$/, "");
    let lines = ["[mcp_servers." + key + "]", "command = " + JSON.stringify(entry.command)];
    lines.push("args = [" + entry.args.map((a) => JSON.stringify(a)).join(", ") + "]");
    let env = Object.entries(entry.env || {});
    if (env.length) {
      lines.push("startup_timeout_sec = 20", "", "[mcp_servers." + key + ".env]");
      for (let [k, v] of env) lines.push(k + " = " + JSON.stringify(v));
    }
    return (body ? body + "\n\n" : "") + lines.join("\n") + "\n";
  }

  async function configTargetPath(c) {
    for (let p of clientPaths(c)) {
      try {
        if (await IOUtils.exists(p)) return { path: p, exists: true };
      } catch (e) {}
    }
    for (let p of clientPaths(c)) {
      try {
        if (await IOUtils.exists(parentDirPath(p))) return { path: p, exists: false };
      } catch (e) {}
    }
    return null;
  }

  async function backupOnce(path) {
    let backup = path + ".zotero-agent-mcp.bak";
    try {
      if (await IOUtils.exists(backup)) return backup;
      if (await IOUtils.exists(path)) await IOUtils.copy(path, backup);
      return backup;
    } catch (e) {
      return "";
    }
  }

  async function writeAtomic(path, text) {
    let dest = normalizePath(path);
    let tmp = dest + ".zotero-agent-mcp.tmp";
    try {
      await IOUtils.writeUTF8(dest, text, { tmpPath: tmp });
    } catch (e) {
      try {
        await IOUtils.writeUTF8(tmp, text);
        await IOUtils.move(tmp, dest);
      } catch (e2) {
        await IOUtils.remove(tmp, { ignoreAbsent: true }).catch(() => {});
        throw e2;
      }
    }
  }

  async function entryForClient(c) {
    let entry = await serverEntry(c.prefer || "node");
    if (c.format === "json-opencode") {
      return {
        type: "local",
        command: [entry.command, ...entry.args],
        environment: entry.env,
        enabled: true,
      };
    }
    return entry;
  }

  function containerPath(format) {
    if (format === "json-vscode-servers") return ["servers"];
    if (format === "json-opencode") return ["mcp"];
    if (format === "json-zcode") return ["mcp", "servers"];
    if (format === "json-amp") return ["amp.mcpServers"];
    return ["mcpServers"];
  }

  async function applyClientConfig(c, { remove } = {}) {
    let target = await configTargetPath(c);
    if (!target) return { id: c.id, ok: false, error: "客户端目录不存在" };
    let path = target.path;
    let original = "";
    if (target.exists) {
      try {
        let stat = await IOUtils.stat(path);
        if (stat.size > 16 * 1024 * 1024) {
          return { id: c.id, ok: false, error: "配置文件过大，请手动复制" };
        }
        original = await IOUtils.readUTF8(path);
      } catch (e) {
        return { id: c.id, ok: false, error: String((e && e.message) || e) };
      }
    }
    let next;
    try {
      if (c.format === "toml-codex") {
        next = remove ? tomlStripSection(original, c.key) : tomlSetSection(original, c.key, await entryForClient(c));
      } else {
        let cleanOriginal = original.replace(/^\uFEFF/, "");
        let text = cleanOriginal.trim() ? cleanOriginal : "{}";
        if (!isParseableJson(text)) {
          return { id: c.id, ok: false, error: "现有配置不是合法 JSON，未改动" };
        }
        let keys = containerPath(c.format);
        if (remove) {
          next = jsonRemoveEntry(text, keys, c.key);
        } else {
          let entryJson = JSON.stringify(await entryForClient(c), null, 2).replace(/\n/g, "\n  ");
          next = jsonSetEntry(text, keys, c.key, entryJson);
          if (next === null) next = jsonCreateEntry(text, keys, c.key, entryJson);
          if (next === null) return { id: c.id, ok: false, error: "无法定位配置根对象" };
        }
        if (!isParseableJson(next)) {
          return { id: c.id, ok: false, error: "合并后 JSON 校验失败，已放弃写入" };
        }
      }
    } catch (e) {
      return { id: c.id, ok: false, error: String((e && e.message) || e) };
    }
    if (next === original) return { id: c.id, ok: true, path, unchanged: true };
    let backup = "";
    try {
      if (target.exists) backup = await backupOnce(path);
      await writeAtomic(path, next);
    } catch (e) {
      return { id: c.id, ok: false, error: "写入失败：" + String((e && e.message) || e) };
    }
    return { id: c.id, ok: true, path, backup, removed: !!remove };
  }
  this.applyClientConfig = applyClientConfig;

  async function applyAll({ onlyConfigured } = {}) {
    let clients = await loadClients(true);
    let results = [];
    for (let c of clients) {
      let st = await clientStatus(c);
      if (!st.pathExists && !st.detected) {
        results.push({ id: c.id, ok: false, skipped: true, error: "未安装" });
        continue;
      }
      if (onlyConfigured && !st.configured) {
        results.push({ id: c.id, ok: false, skipped: true });
        continue;
      }
      results.push(await applyClientConfig(c));
    }
    return results;
  }
  this.applyAllClientConfigs = applyAll;

  async function revertAll() {
    let clients = await loadClients(true);
    let results = [];
    for (let c of clients) {
      let st = await clientStatus(c);
      if (!st.configured) continue;
      results.push(await applyClientConfig(c, { remove: true }));
    }
    return results;
  }
  this.revertAllClientConfigs = revertAll;

  // Called on startup and after a token change: keeps every detected client in sync.
  this.autoSyncClients = async function () {
    if (getPref("autoSync") === false) return [];
    let results = await applyAll();
    let changed = results.filter((r) => r.ok && !r.unchanged);
    if (changed.length) {
      Zotero.debug("AgentMCP: synced " + changed.length + " client config(s): " + changed.map((r) => r.id).join(", "));
    }
    return results;
  };

  // Ready-to-paste snippets for scripts/CI: one file, rewritten only when it changes.
  async function releaseAgentConfigs() {
    let clients = await loadClients();
    let out = { url: baseUrl(), bridge: AgentMCP.bridgePath(), tokenHint: "full token in each snippet", clients: {} };
    for (let c of clients) {
      out.clients[c.id] = {
        label: c.label || c.id,
        format: c.format,
        node: await clientSnippet(c, "node"),
        npx: await clientSnippet(c, "npx"),
      };
    }
    await writeIfChanged(dataFilePath("agent-configs.json"), JSON.stringify(out, null, 2));
    return out;
  }
  this.releaseAgentConfigs = releaseAgentConfigs;

  // Subprocess.call does not resolve PATH entries, so system tools need absolute paths.
  const SYSTEM_TOOLS = {
    ln: ["/bin/ln", "/usr/bin/ln"],
    rm: ["/bin/rm", "/usr/bin/rm"],
  };
  async function systemTool(name) {
    for (let candidate of SYSTEM_TOOLS[name] || []) {
      try {
        if (await IOUtils.exists(candidate)) return candidate;
      } catch (e) {}
    }
    return "";
  }

  // ---------- skill install / undo (the only place the plugin writes outside its data dir) ----------
  const SKILL_MANIFEST = "skills-installed.json";

  async function readManifest() {
    let text = await readTextIfExists(dataFilePath(SKILL_MANIFEST));
    try {
      let m = JSON.parse(text || "{}");
      return m && typeof m === "object" && m.entries ? m : { version: 1, entries: {} };
    } catch (e) {
      return { version: 1, entries: {} };
    }
  }
  async function writeManifest(m) {
    await writeIfChanged(dataFilePath(SKILL_MANIFEST), JSON.stringify(m, null, 2));
  }

  async function skillTargets() {
    let clients = await loadClients();
    let out = [];
    for (let c of clients) {
      let dir = expandPath(c.skillDir || "");
      if (!dir) continue;
      let parent = parentDirPath(dir);
      let clientRoot = parentDirPath(parent);
      let parentExists = false;
      try {
        parentExists = (await IOUtils.exists(parent)) || (await IOUtils.exists(clientRoot));
      } catch (e) {}
      out.push({ id: c.id, label: c.label || c.id, dir, parentExists });
    }
    return out;
  }
  this.skillTargets = skillTargets;

  this.skillState = async function () {
    let manifest = await readManifest();
    let targets = await skillTargets();
    return targets.map((t) => {
      let entry = manifest.entries[t.dir];
      return {
        id: t.id,
        label: t.label,
        dir: t.dir,
        parentExists: t.parentExists,
        installed: !!entry,
        mode: entry ? entry.mode : "",
        stale: !!(entry && entry.version !== String(AgentMCP.version)),
      };
    });
  };

  async function installSkillOne(target) {
    let srcFile = AgentMCP.skillPath();
    let src = AgentMCP._skillSource;
    if (!src) return { dir: target.dir, ok: false, error: "skill source missing" };
    let parent = parentDirPath(target.dir);
    let clientRoot = parentDirPath(parent);
    if (!(await IOUtils.exists(parent)) && !(await IOUtils.exists(clientRoot))) {
      return { dir: target.dir, ok: false, error: "客户端目录不存在" };
    }
    await IOUtils.makeDirectory(parent, { ignoreExisting: true });
    // Clean up a previous install of ours before recreating it.
    await removeSkillOne(target.dir, { quiet: true });
    let mode = "copy";
    if (!Zotero.isWin) {
      let ln = await systemTool("ln");
      let srcDir = joinPath(bridgeDir(), "skill");
      if (ln) {
        let res = await runProcess(ln, ["-s", srcDir, target.dir], 5000);
        if (res && res.code === 0) mode = "symlink";
        else Zotero.debug("AgentMCP: ln -s failed: " + ((res && res.stderr) || "no result"));
      }
    }
    if (mode === "copy") {
      try {
        await IOUtils.makeDirectory(target.dir, { ignoreExisting: true });
        await IOUtils.writeUTF8(joinPath(target.dir, "SKILL.md"), src);
      } catch (e) {
        return { dir: target.dir, ok: false, error: String((e && e.message) || e) };
      }
    }
    return { dir: target.dir, ok: true, mode, srcFile };
  }

  async function removeSkillOne(dir, { quiet } = {}) {
    let manifest = await readManifest();
    let entry = manifest.entries[dir];
    if (!entry) {
      if (!quiet) return { dir, ok: false, error: "未由本插件安装" };
      return { dir, ok: true, skipped: true };
    }
    try {
      if (entry.mode === "symlink") {
        let rm = await systemTool("rm");
        let res = rm ? await runProcess(rm, ["-f", dir], 5000) : null;
        if (!res || res.code !== 0) {
          // Fall back to unlinking through IOUtils (works for dangling links on some builds).
          await IOUtils.remove(dir, { ignoreAbsent: true });
        }
      } else {
        let file = joinPath(dir, "SKILL.md");
        let cur = await readTextIfExists(file);
        if (cur !== null && cur === String(AgentMCP._skillSource || "")) {
          await IOUtils.remove(file, { ignoreAbsent: true });
        }
        // Only drop the directory when nothing else lives in it.
        try {
          let children = await IOUtils.getChildren(dir);
          if (!children.length) await IOUtils.remove(dir, { ignoreAbsent: true });
        } catch (e) {}
      }
    } catch (e) {
      return { dir, ok: false, error: String((e && e.message) || e) };
    }
    delete manifest.entries[dir];
    await writeManifest(manifest);
    return { dir, ok: true };
  }

  this.installSkills = async function () {
    let targets = await skillTargets();
    let results = [];
    let manifest = await readManifest();
    for (let t of targets) {
      if (!t.parentExists) {
        results.push({ dir: t.dir, id: t.id, ok: false, error: "客户端目录不存在" });
        continue;
      }
      let r = await installSkillOne(t);
      results.push(Object.assign({ id: t.id }, r));
      if (r.ok) {
        manifest.entries[t.dir] = {
          id: t.id,
          mode: r.mode,
          version: String(AgentMCP.version),
          source: joinPath(bridgeDir(), "skill"),
          at: new Date().toISOString(),
        };
      }
    }
    await writeManifest(manifest);
    return results;
  };

  this.uninstallSkills = async function () {
    let manifest = await readManifest();
    let results = [];
    for (let dir of Object.keys(manifest.entries)) {
      results.push(await removeSkillOne(dir));
    }
    return results;
  };

  // ---------- MCP bridge release ----------
  async function releaseBridgeFiles() {
    let src = AgentMCP._bridgeSource;
    if (!src) return;
    let dir = bridgeDir();
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    let dest = AgentMCP.bridgePath();
    let wrote = 0;
    if (await writeIfChanged(dest, src)) wrote++;
    if (AgentMCP._skillSource) {
      let skillDir = joinPath(dir, "skill");
      await IOUtils.makeDirectory(skillDir, { ignoreExisting: true });
      if (await writeIfChanged(PathUtils.join(skillDir, "SKILL.md"), AgentMCP._skillSource)) wrote++;
    }
    if (AgentMCP._clientsSource) {
      let pretty = AgentMCP._clientsSource;
      try {
        pretty = JSON.stringify(JSON.parse(AgentMCP._clientsSource), null, 2);
      } catch (e) {}
      if (await writeIfChanged(dataFilePath("clients.json"), pretty)) wrote++;
    }
    if (await writeIfChanged(dataFilePath("version.txt"), String(AgentMCP.version))) wrote++;
    // convenience config file (kept for hand-rolled setups)
    let cfg = {
      _comment:
        "Generated by Zotero-Agent-MCP. Paste the 'mcpServers' block into your agent's MCP config, or use the settings pane's per-client copy buttons.",
      url: baseUrl(),
      token: getPref("token"),
      bridge: dest,
      mcpServers: {
        "zotero-agent": await serverEntry("node"),
      },
    };
    if (await writeIfChanged(dataFilePath("zotero-agent-mcp.mcp.json"), JSON.stringify(cfg, null, 2))) wrote++;
    await releaseAgentConfigs();
    bridgeReleasedVersion = String(AgentMCP.version);
    if (wrote) Zotero.debug(`AgentMCP: released ${wrote} file(s) to ${dir}`);
  }
  this.releaseBridgeFiles = releaseBridgeFiles;
  this.bridgeReleasedVersion = () => bridgeReleasedVersion;

  // ---------- connection self-test (real node + bridge, no shell glue) ----------
  this.testConnection = async function () {
    let t0 = Date.now();
    let node = await nodePath();
    let bridge = AgentMCP.bridgePath();
    let out = { node, bridge, nodeOk: false, nodeVersion: "", mcpOk: false, tools: 0, toolSet: "", ms: 0, error: null };
    let ver = await runProcess(node, ["--version"], 6000);
    if (ver && ver.code === 0) {
      out.nodeOk = true;
      out.nodeVersion = String(ver.stdout || "").trim();
    } else if (!getSubprocess()) {
      out.error = "当前 Zotero 构建禁止启动子进程，请手动在终端执行：node <bridge> --selftest";
      out.ms = Date.now() - t0;
      return out;
    } else {
      out.error = (ver && (ver.stderr || `node 退出码 ${ver.code}`)) || "找不到 node";
      out.ms = Date.now() - t0;
      return out;
    }
    let res = await runProcess(node, [bridge, "--url", baseUrl(), "--token", String(getPref("token") || ""), "--selftest"], 15000);
    out.ms = Date.now() - t0;
    if (!res || res.code !== 0) {
      out.error = (res && (res.stderr || "").trim()) || "自检失败";
      return out;
    }
    try {
      let line = String(res.stdout || "").trim().split("\n").filter(Boolean).pop();
      let parsed = JSON.parse(line);
      out.mcpOk = !!parsed.ok;
      out.tools = parsed.tools || 0;
      out.toolSet = parsed.toolSet || "";
      out.error = parsed.error || null;
    } catch (e) {
      out.error = "自检输出无法解析：" + String((e && e.message) || e);
    }
    return out;
  };

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
    // Requests can arrive in the first milliseconds after startup, before the token
    // has been reconciled with its on-disk copy. Already resolved afterwards (free).
    if (readyPromise) await readyPromise;
    let t0 = Date.now();
    let status = 500;
    let body;
    let tokenSeen = "";
    try {
      if (!getPref("enabled")) {
        status = 503;
        body = errBody("disabled", "Zotero-Agent-MCP is disabled in Zotero Settings → AgentMCP");
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
  // /ping is the agent's first call, so it stays small: the 34-route list moved
  // behind ?verbose=1 (v0.6.0). libraries stay inline — agents use them right away.
  async function hPing(ctx) {
    let verbose = false;
    try {
      let v = ctx && ctx.params ? ctx.params.get("verbose") : "";
      verbose = v === "1" || v === "true";
    } catch (e) {}
    let out = {
      plugin: "zotero-agent-mcp",
      version: String(AgentMCP.version),
      zoteroVersion: Zotero.version,
      baseUrl: baseUrl(),
      enabled: !!getPref("enabled"),
      scopes: enabledScopes(),
      libraries: await allLibrariesJSON(),
      endpointCount: ROUTES.length,
      startupMs: AgentMCP.startupMs ?? null,
      time: new Date().toISOString(),
    };
    if (verbose) {
      out.endpoints = ROUTES.map(
        (r) => `${(r.methods || ["GET"]).join("/")} ${r.path}${r.scope ? `  [${r.scope}]` : "  [public]"}`
      );
    }
    return out;
  }

  const hLibraries = async () => ({ libraries: await allLibrariesJSON() });

  const hCollections = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let totalItems = 0;
    let unfiledItems = 0;
    try {
      let totRows = await Zotero.DB.queryAsync(
        `SELECT COUNT(*) AS cnt FROM items i
         JOIN itemTypes it USING (itemTypeID)
         WHERE i.libraryID = ?
           AND it.typeName NOT IN ('note', 'attachment', 'annotation')
           AND i.itemID NOT IN (SELECT itemID FROM deletedItems)`,
        [libraryID]
      );
      totalItems = Number(totRows[0]?.cnt || 0);
      let unfRows = await Zotero.DB.queryAsync(
        `SELECT COUNT(*) AS cnt FROM items i
         JOIN itemTypes it USING (itemTypeID)
         WHERE i.libraryID = ?
           AND it.typeName NOT IN ('note', 'attachment', 'annotation')
           AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
           AND i.itemID NOT IN (SELECT itemID FROM collectionItems)`,
        [libraryID]
      );
      unfiledItems = Number(unfRows[0]?.cnt || 0);
    } catch (e) {}
    return { libraryID, totalItems, unfiledItems, collections: await collectionsJSON(libraryID) };
  };

  const hSearch = async (ctx) => {
    let q = (ctx.params.get("q") || "").trim();
    let tag = (ctx.params.get("tag") || "").trim() || null;
    let itemType = (ctx.params.get("itemType") || "").trim() || null;
    let collection = (ctx.params.get("collection") || "").trim() || null;
    if (!q && !tag && !itemType && !collection) {
      throw new ABError(400, "bad_request", "Missing 'q' or filter parameter ('tag', 'itemType', 'collection')");
    }
    let libParam = ctx.params.get("library") || "user";
    let compact = boolParam(ctx.params.get("compact"));
    let recursive = boolParam(ctx.params.get("recursive"));
    let limit = parseLimit(ctx.params, 25, 500, compact);
    let offset = parseOffset(ctx.params);
    let mode = ctx.params.get("mode") === "everything" ? "quicksearch-everything" : "quicksearch-titleCreatorYear";
    let libs = [];
    if (libParam === "all") {
      for (let l of await allLibrariesJSON()) libs.push(l.id);
    } else {
      libs.push(await resolveLibrary(libParam));
    }
    let seen = new Set();
    let all = [];
    for (let libraryID of libs) {
      let allowedColIDs = null;
      let colTarget = null;
      if (collection) {
        if (libParam === "all") {
          try {
            colTarget = await resolveCollectionKeyOrName(libraryID, collection);
          } catch (e) {
            continue;
          }
        } else {
          colTarget = await resolveCollectionKeyOrName(libraryID, collection);
        }
        allowedColIDs = recursive
          ? descendantCollectionIDs(libraryID, colTarget.id)
          : new Set([colTarget.id]);
      }
      if (!q && !tag && !itemType && allowedColIDs) {
        for (let cid of allowedColIDs) {
          let cObj = Zotero.Collections.get(cid);
          if (!cObj || cObj.deleted) continue;
          await ensureLoaded(cObj);
          for (let ci of cObj.getChildItems(false, false)) {
            if (!seen.has(ci.id)) {
              seen.add(ci.id);
              all.push(ci.id);
            }
          }
        }
        continue;
      }
      let ids = await doSearch(libraryID, q, mode, tag, itemType);
      for (let id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          all.push(id);
        }
      }
      if (allowedColIDs) {
        let filtered = [];
        let libItems = await Zotero.Items.getAsync(all);
        for (let it of libItems) {
          if (it.libraryID !== libraryID) {
            filtered.push(it.id);
            continue;
          }
          let itemCols = it.getCollections();
          if (itemCols.some((cid) => allowedColIDs.has(cid))) {
            filtered.push(it.id);
          }
        }
        all = filtered;
      }
    }
    let items = await Zotero.Items.getAsync(all);
    items = items.filter((i) => i.isRegularItem() && !i.deleted);
    sortItemsDesc(items);
    let total = items.length;
    let page = items.slice(offset, offset + limit);
    return {
      query: q,
      mode,
      ...(tag ? { tag } : {}),
      ...(itemType ? { itemType } : {}),
      ...(collection ? { collection, recursive } : {}),
      compact,
      ...pageMeta(total, offset, limit, page.length),
      items: await Promise.all(page.map((i) => itemToJSON(i, { compact }))),
    };
  };

  const hRecent = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let compact = boolParam(ctx.params.get("compact"));
    let unfiled = boolParam(ctx.params.get("unfiled"));
    let limit = parseLimit(ctx.params, 20, 500, compact);
    let offset = parseOffset(ctx.params);
    let { total, items } = await recentItems(libraryID, limit, offset, unfiled);
    return {
      libraryID,
      ...(unfiled ? { unfiled: true } : {}),
      compact,
      ...pageMeta(total, offset, limit, items.length),
      items: await Promise.all(items.map((i) => itemToJSON(i, { compact }))),
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
    let raw = String(s || "");
    try { raw = decodeURIComponent(raw); } catch (e) {}
    raw = raw.trim();
    // recursive=true so nested subcollections resolve by key/name/path too
    let cols = Zotero.Collections.getByLibrary(libraryID, true).filter((x) => !x.deleted);
    let byID = new Map(cols.map((x) => [x.id, x]));
    function pathOf(col) {
      let parts = [col.name];
      let cur = col;
      let guard = 0;
      while (cur.parentID && byID.has(cur.parentID) && guard++ < 20) {
        cur = byID.get(cur.parentID);
        parts.unshift(cur.name);
      }
      return parts.join(" / ");
    }
    let c = cols.find((x) => x.key === raw || x.name === raw || pathOf(x) === raw);
    if (!c) {
      throw new ABError(404, "not_found", `No collection '${raw}' in library ${libraryID} (match by collection key, exact name, or 'Parent / Child' path)`);
    }
    return c;
  }

  function descendantCollectionIDs(libraryID, rootID) {
    let cols = Zotero.Collections.getByLibrary(libraryID, true).filter((x) => !x.deleted);
    let childrenByParent = new Map();
    for (let col of cols) {
      let pid = col.parentID || 0;
      if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
      childrenByParent.get(pid).push(col.id);
    }
    let out = new Set([rootID]);
    let stack = [rootID];
    while (stack.length) {
      let cur = stack.pop();
      for (let cid of childrenByParent.get(cur) || []) {
        if (!out.has(cid)) {
          out.add(cid);
          stack.push(cid);
        }
      }
    }
    return out;
  }

  function expandCollectionAncestors(ids, byID) {
    let out = [];
    let seen = new Set();
    for (let startId of ids) {
      let curId = startId;
      let guard = 0;
      while (curId && !seen.has(curId) && guard++ < 50) {
        seen.add(curId);
        out.push(curId);
        let col = byID.get(curId);
        curId = col && col.parentID ? col.parentID : 0;
      }
    }
    return out;
  }

  function ancestorCollectionIDs(libraryID, ids) {
    let cols = Zotero.Collections.getByLibrary(libraryID, true).filter((x) => !x.deleted);
    let byID = new Map(cols.map((x) => [x.id, x]));
    return expandCollectionAncestors(ids, byID);
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
    for (let t of tags.slice(0, 200)) {
      let tag = String(t || "").trim();
      if (tag && !item.hasTag(tag)) item.addTag(tag);
    }
  }

  async function applyItemCollections(item, libraryID, collections, opts = {}) {
    if (!Array.isArray(collections) || !collections.length) return;
    let rawIDs = [];
    for (let c of collections.slice(0, 200)) {
      let col = await resolveCollectionKeyOrName(libraryID, String(c));
      rawIDs.push(col.id);
    }
    let collectionIDs = opts.includeAncestors === false ? Array.from(new Set(rawIDs)) : ancestorCollectionIDs(libraryID, rawIDs);
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
      let title = String(data.title || (data.fields && data.fields.title) || "").trim() || (fileName ? fileName.replace(/\.[^.]+$/, "") : "");
      if (!title && !(data.fields && (data.fields.title || data.fields.shortTitle))) {
        throw new ABError(400, "bad_request", "creating an item without 'path' needs a 'title' (or fields.title); pass 'path' to build one from a local file");
      }
      item.setField("title", title);
      skippedFields = applyItemFields(item, data.fields);
      applyItemCreators(item, data.creators);
      applyItemTags(item, data.tags);
      await applyItemCollections(item, libraryID, data.collections, { includeAncestors: data.includeAncestors !== false });
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
    let includeAncestors = data.includeAncestors !== false;
    let seen = new Set();
    let ids = [];
    for (let c of data.collections.slice(0, 200)) {
      let col = await resolveCollectionKeyOrName(libraryID, String(c));
      if (!seen.has(col.id)) {
        seen.add(col.id);
        ids.push(col.id);
      }
    }
    let expanded = includeAncestors ? ancestorCollectionIDs(libraryID, ids) : ids;
    // setCollections dedupes, accepts ids/keys, and no-ops when unchanged;
    // add/remove are computed here so the whole change is a single saveTx.
    let before = item.getCollections().slice().sort((a, b) => a - b).join();
    let current = item.getCollections();
    let final;
    if (mode === "replace") {
      final = expanded;
    } else if (mode === "add") {
      let cur = new Set(current);
      final = current.concat(expanded.filter((id) => !cur.has(id)));
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
    let limit = parseLimit(ctx.params, 50, 500, false);
    let offset = parseOffset(ctx.params);
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
    let all = cols
      .map((c) => ({ key: c.key, name: c.name, parentKey: c.parentKey || null, path: pathOf(c) }))
      .filter((c) => c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q))
      .sort((a, b) => a.path.localeCompare(b.path));
    let total = all.length;
    let page = all.slice(offset, offset + limit);
    return { query: q, ...pageMeta(total, offset, limit, page.length), collections: page };
  };

  const hCollectionItems = async (ctx) => {
    let libraryID = await resolveLibrary(ctx.params.get("library") || "user");
    let rawKey = String(ctx.pathParams.key || "");
    try { rawKey = decodeURIComponent(rawKey); } catch (e) {}
    rawKey = rawKey.trim();
    let compact = boolParam(ctx.params.get("compact"));
    let recursive = boolParam(ctx.params.get("recursive"));
    let limit = parseLimit(ctx.params, 50, 500, compact);
    let offset = parseOffset(ctx.params);
    let lower = rawKey.toLowerCase();
    if (lower === "root" || lower === "all" || lower === "unfiled") {
      let isUnfiled = lower === "unfiled";
      let { total, items } = await recentItems(libraryID, limit, offset, isUnfiled);
      return {
        key: isUnfiled ? "unfiled" : "root",
        name: isUnfiled ? "Unfiled Items" : "All Library Items",
        libraryID,
        compact,
        ...pageMeta(total, offset, limit, items.length),
        items: await Promise.all(items.map((i) => itemToJSON(i, { compact }))),
      };
    }
    // accept an 8-char key, exact collection name, or 'Parent / Child' path
    let col = /^[A-Z0-9]{8}$/.test(rawKey)
      ? await findCollection(libraryID, rawKey)
      : await resolveCollectionKeyOrName(libraryID, rawKey);
    await ensureLoaded(col);
    let items;
    if (recursive) {
      let colIDs = descendantCollectionIDs(libraryID, col.id);
      let byID = new Map();
      for (let cid of colIDs) {
        let cObj = Zotero.Collections.get(cid);
        if (!cObj || cObj.deleted) continue;
        await ensureLoaded(cObj);
        for (let ci of cObj.getChildItems(false, false)) {
          if (!ci.deleted && ci.isRegularItem() && !byID.has(ci.id)) {
            byID.set(ci.id, ci);
          }
        }
      }
      items = Array.from(byID.values());
    } else {
      items = col.getChildItems(false, false).filter((i) => !i.deleted && i.isRegularItem());
    }
    sortItemsDesc(items);
    let total = items.length;
    let page = items.slice(offset, offset + limit);
    return {
      key: col.key,
      name: col.name,
      libraryID,
      ...(recursive ? { recursive: true } : {}),
      compact,
      ...pageMeta(total, offset, limit, page.length),
      items: await Promise.all(page.map((i) => itemToJSON(i, { compact }))),
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
      else await applyItemCollections(item, libraryID, data.collections, { includeAncestors: data.includeAncestors !== false });
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
    let compact = boolParam(ctx.params.get("compact"));
    let limit = parseLimit(ctx.params, 50, 500, compact);
    let offset = parseOffset(ctx.params);
    let countRows = await Zotero.DB.queryAsync(
      `SELECT COUNT(*) AS cnt FROM items i
       JOIN deletedItems d USING (itemID)
       WHERE i.libraryID = ?`,
      [libraryID]
    );
    let total = Number(countRows[0]?.cnt || 0);
    let rows = await Zotero.DB.queryAsync(
      `SELECT i.itemID AS itemID FROM items i
       JOIN deletedItems d USING (itemID)
       WHERE i.libraryID = ?
       ORDER BY d.dateDeleted DESC, i.key DESC LIMIT ? OFFSET ?`,
      [libraryID, limit, offset]
    );
    let items = await Zotero.Items.getAsync(rows.map((r) => r.itemID));
    return {
      libraryID,
      compact,
      ...pageMeta(total, offset, limit, items.length),
      items: await Promise.all(items.map((i) => itemToJSON(i, { compact }))),
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
    let q = (ctx.params.get("q") || "").trim().toLowerCase();
    let limit = parseLimit(ctx.params, 500, 5000, false);
    let offset = parseOffset(ctx.params);
    let tags = await Zotero.Tags.getAll(libraryID);
    let all = tags
      .map((t) => (t && typeof t === "object" ? { tag: t.tag, type: t.type ?? null } : { tag: String(t), type: null }))
      .filter((t) => !q || t.tag.toLowerCase().includes(q))
      .sort((a, b) => a.tag.localeCompare(b.tag));
    let total = all.length;
    let page = all.slice(offset, offset + limit);
    return {
      libraryID,
      ...(q ? { query: q } : {}),
      ...pageMeta(total, offset, limit, page.length),
      tags: page,
    };
  };

  const hDeleteTags = async (ctx) => {
    if (ctx.method !== "POST") throw new ABError(400, "bad_request", "POST JSON {tags: [name, …] (max 200), library?}");
    let data = ctx.data || {};
    let libraryID = await resolveLibrary(data.library || "user");
    requireEditable(libraryID);
    if (!Array.isArray(data.tags) || !data.tags.length) {
      throw new ABError(400, "bad_request", "'tags' must be a non-empty array of tag names");
    }
    let names = data.tags.slice(0, 200).map((t) => String(t || "").trim()).filter(Boolean);
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
    let compact = boolParam(ctx.params.get("compact"));
    let limit = parseLimit(ctx.params, 50, 500, compact);
    let offset = parseOffset(ctx.params);
    let ids = await s.search();
    let items = (await Zotero.Items.getAsync(ids)).filter((i) => i.isRegularItem() && !i.deleted);
    sortItemsDesc(items);
    let total = items.length;
    let page = items.slice(offset, offset + limit);
    return {
      key: s.key,
      name: s.name,
      compact,
      ...pageMeta(total, offset, limit, page.length),
      items: await Promise.all(page.map((i) => itemToJSON(i, { compact }))),
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
  // Startup is split in two: the synchronous part registers the HTTP surface (so
  // agents can connect within a few ms), and everything that touches the disk runs
  // afterwards behind `readyPromise`, which handlers await.
  this.startup = async function ({ id, version, rootURI, bridgeSource, skillSource, clientsSource }) {
    let t0 = Date.now();
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this._bridgeSource = bridgeSource;
    this._skillSource = skillSource;
    this._clientsSource = clientsSource;
    Zotero.AgentMCP = AgentMCP; // expose for prefs.js and debugging

    seedDefaults();
    // Seed a token synchronously so the very first request has something to match;
    // the on-disk copy is reconciled below and wins if it differs.
    if (!String(getPref("token") || "")) setPref("token", randomString(40));

    for (let r of ROUTES) {
      let ep = makeEndpoint(r.scope, r.handler, { methods: r.methods });
      Zotero.Server.Endpoints[r.path] = ep;
      registeredEndpoints.push(r.path);
    }
    let registeredMs = Date.now() - t0;

    // Register the settings pane (auto-unregistered on plugin shutdown)
    Zotero.PreferencePanes.register({
      pluginID: id,
      src: rootURI + "prefs.xhtml",
      scripts: [rootURI + "prefs.js"],
      image: rootURI + "icons/prefs-64.png",
      id: "zotero-agent-mcp-prefs",
      label: "Zotero-Agent-MCP",
    }).catch((e) => Zotero.logError(e));

    // Deferred maintenance: token reconciliation, optional legacy migration, file
    // release, daily audit rotation. Nothing here is needed to answer a request.
    readyPromise = (async () => {
      try {
        await migrateOldBranding();
        await restoreStableToken();
        await releaseBridgeFiles();
        await AgentMCP.autoSyncClients();
        await maybeRotateAudit();
        // Clear any error note from a previous launch.
        await IOUtils.remove(dataFilePath("startup-error.txt"), { ignoreAbsent: true }).catch(() => {});
      } catch (e) {
        Zotero.logError(e);
        // Surfaced in 高级设置 and handy when a user reports "setup did nothing".
        try {
          await IOUtils.writeUTF8(
            dataFilePath("startup-error.txt"),
            `${new Date().toISOString()}\n${(e && e.stack) || e}\n`
          );
        } catch (e2) {}
      }
      AgentMCP.startupMs = Date.now() - t0;
      AgentMCP.startupBreakdown = { total: AgentMCP.startupMs, endpoints: registeredMs };
      Zotero.debug(
        `AgentMCP ready in ${AgentMCP.startupMs}ms (${ROUTES.length} endpoints in ${registeredMs}ms, ` +
          `bridge=${bridgeReleasedVersion || "-"})`
      );
    })();

    Zotero.debug(`AgentMCP ${version}: ${ROUTES.length} endpoints registered on ${baseUrl()}/`);
  };

  this.shutdown = function () {
    for (let path of registeredEndpoints) {
      delete Zotero.Server.Endpoints[path];
    }
    registeredEndpoints = [];
    Zotero.debug("AgentMCP: endpoints unregistered");
  };
}();
