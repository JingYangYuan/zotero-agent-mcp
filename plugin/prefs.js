/* Zotero-Agent-MCP — preferences pane logic.
 * Runs inside the Zotero prefs window (pane iframe). All state is stored via
 * Zotero.Prefs under extensions.zotero.zotero-agent-mcp.* — no XUL preference binding,
 * so this file is the single source of truth for UI <-> pref sync.
 */
(function () {
  if (window.__agentBridgePrefsLoaded) return;
  window.__agentBridgePrefsLoaded = true;

  const P = (k) => {
    try {
      return Zotero.Prefs.get("zotero-agent-mcp." + k);
    } catch (e) {
      return undefined;
    }
  };
  const S = (k, v) => Zotero.Prefs.set("zotero-agent-mcp." + k, v);
  const $ = (id) => window.document.getElementById(id);

  function copyText(str) {
    try {
      const ch = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Components.interfaces.nsIClipboardHelper);
      ch.copyString(str);
      return true;
    } catch (e) {
      Zotero.logError(e);
      return false;
    }
  }

  function baseUrl() {
    let port = 23119;
    try {
      port = Zotero.Server.port;
    } catch (e) {}
    return `http://127.0.0.1:${port}/zotero-agent-mcp`;
  }

  function mcpConfig() {
    return JSON.stringify(
      {
        mcpServers: {
          "zotero-agent": {
            type: "stdio",
            command: "node",
            args: [Zotero.AgentMCP.bridgePath()],
            env: {
              ZOTERO_AGENT_URL: baseUrl(),
              ZOTERO_AGENT_TOKEN: String(P("token") || ""),
            },
          },
        },
      },
      null,
      2
    );
  }

  function curlExample() {
    const t = String(P("token") || "");
    const u = baseUrl();
    return [
      `# 1) 状态自检（无需令牌）`,
      `curl ${u}/ping`,
      ``,
      `# 2) 搜索（标题/作者/年份）`,
      `curl -H "Authorization: Bearer ${t}" "${u}/search?q=machine+learning&limit=5"`,
      ``,
      `# 3) 条目详情 / 全文 / 标注 / 引文`,
      `curl -H "Authorization: Bearer ${t}" "${u}/item/ABCD1234?library=user"`,
      `curl -H "Authorization: Bearer ${t}" "${u}/item/ABCD1234/fulltext?maxChars=20000"`,
      `curl -H "Authorization: Bearer ${t}" "${u}/item/ABCD1234/annotations"`,
      `curl -H "Authorization: Bearer ${t}" "${u}/item/ABCD1234/cite?format=bibtex"`,
      ``,
      `# 4) 写入（需在上方开启 write 作用域）`,
      `curl -X POST -H "Authorization: Bearer ${t}" -H "Content-Type: application/json"`,
      `  -d '{"itemKey":"ABCD1234","html":"agent 摘要笔记"}' "${u}/note"`,
    ].join("\n");
  }

  function bindCheck(id, key) {
    let el = $(id);
    if (!el) return;
    el.checked = !!P(key);
    el.addEventListener("command", () => S(key, el.checked));
  }

  function bindInput(id, key, numeric) {
    let el = $(id);
    if (!el) return;
    let v = P(key);
    el.value = v === undefined || v === null ? "" : String(v);
    el.addEventListener("change", () => {
      if (numeric) {
        let n = parseInt(el.value, 10);
        S(key, isNaN(n) ? 0 : n);
      } else {
        S(key, el.value.trim());
      }
    });
  }

  async function refreshStatus() {
    try {
      // hero: version chip, endpoint, running status
      let ver = $("zam-version");
      if (ver) ver.textContent = "v" + (Zotero.AgentMCP.version || "");
      let url = $("zam-url");
      if (url) url.textContent = baseUrl();
      let st = $("zam-status");
      if (st) {
        let on = !!P("enabled");
        st.classList.toggle("off", !on);
        st.textContent = on ? "运行中" : "已停用";
      }

      let bridgePath = Zotero.AgentMCP.bridgePath();
      let exists = await IOUtils.exists(bridgePath);
      let bs = $("ab-bridge-status");
      if (bs) bs.textContent = exists ? `桥接脚本：${bridgePath}` : "桥接脚本尚未释放（重启 Zotero 或稍候）";
      let ai = $("ab-audit-info");
      if (ai) {
        let auditPath = Zotero.AgentMCP.auditPath();
        let size = "";
        try {
          let stat = await IOUtils.stat(auditPath);
          size = ` · ${(stat.size / 1024).toFixed(1)} KB`;
        } catch (e) {}
        ai.textContent = `日志：${auditPath}${size}`;
      }
    } catch (e) {}
  }

  try {
    initWhenReady();
  } catch (e) {
    Zotero.logError(e);
  }

  // The pane fragment may not be attached to the document yet when this script
  // runs — wait until our root element exists, then bind everything.
  function initWhenReady() {
    if (!window.document.getElementById("ab-enabled")) {
      window.setTimeout(initWhenReady, 50);
      return;
    }
    init();
  }

  function init() {
    // Enable toggle + scopes
    bindCheck("ab-enabled", "enabled");
    $("ab-enabled")?.addEventListener("command", refreshStatus);
    bindCheck("ab-scope-read", "scope-read");
    bindCheck("ab-scope-fulltext", "scope-fulltext");
    bindCheck("ab-scope-annotations", "scope-annotations");
    bindCheck("ab-scope-export", "scope-export");
    bindCheck("ab-scope-write", "scope-write");
    bindCheck("ab-scope-files", "scope-files");
    bindCheck("ab-audit", "audit");

    // Token display
    let tokenEl = $("ab-token");
    if (tokenEl) {
      tokenEl.value = String(P("token") || "");
    }
    $("ab-regen")?.addEventListener("command", () => {
      let t = Zotero.AgentMCP.regenerateToken();
      if (tokenEl) tokenEl.value = t;
    });
    $("ab-copy-token")?.addEventListener("command", () => copyText(String(P("token") || "")));

    // Library allowlist + rate limit
    bindInput("ab-libs", "allowedLibraries", false);
    bindInput("ab-rate", "rateLimit", true);

    // Integration buttons
    $("ab-copy-mcp")?.addEventListener("command", () => copyText(mcpConfig()));
    $("ab-copy-curl")?.addEventListener("command", () => copyText(curlExample()));
    $("ab-open-bridge")?.addEventListener("command", () => {
      try {
        Zotero.File.reveal(Zotero.AgentMCP.bridgePath());
      } catch (e) {
        try {
          Zotero.launchFile(Zotero.AgentMCP.bridgeDir());
        } catch (e2) {}
      }
    });
    $("ab-open-audit")?.addEventListener("command", () => {
      try {
        Zotero.File.reveal(Zotero.AgentMCP.auditPath());
      } catch (e) {}
    });

    refreshStatus();
  }
})();
