/* Zotero-Agent-MCP — preferences pane (v0.6.1)
 *
 * Layout: status → service/token → agent connect → advanced.
 * Client configs are written directly (merge-only, backed up, undoable);
 * start-up auto-sync keeps tokens in step.
 */
(function () {
  if (window.__zoteroAgentMCPPrefsLoaded) return;
  window.__zoteroAgentMCPPrefsLoaded = true;

  const XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
  const HTML = "http://www.w3.org/1999/xhtml";
  const P = (k) => {
    try {
      return Zotero.Prefs.get("zotero-agent-mcp." + k);
    } catch (e) {
      return undefined;
    }
  };
  const S = (k, v) => Zotero.Prefs.set("zotero-agent-mcp." + k, v);
  const $ = (id) => window.document.getElementById(id);
  const api = () => Zotero.AgentMCP;

  const state = { tokenVisible: false, statuses: [], clientMap: new Map(), busy: false, loadError: "", armedAt: 0 };

  function el(ns, tag, attrs, text) {
    let node = window.document.createElementNS(ns, tag);
    for (let [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null) continue;
      if (k === "class" || k.startsWith("on")) continue;
      node.setAttribute(k, v);
    }
    if (attrs && attrs.class) node.setAttribute("class", attrs.class);
    if (text !== undefined) node.textContent = text;
    if (attrs) {
      for (let [k, v] of Object.entries(attrs)) {
        if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      }
    }
    return node;
  }
  const h = (tag, attrs, text) => el(HTML, tag, attrs, text);
  const x = (tag, attrs, text) => el(XUL, tag, attrs, text);

  let toastTimer = null;
  function toast(msg) {
    let t = $("zam-toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    let ms = msg && (msg.includes("失败") || msg.length > 24) ? 4000 : 1600;
    toastTimer = setTimeout(() => t.classList.remove("show"), ms);
  }

  function copyText(str) {
    try {
      Components.classes["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Components.interfaces.nsIClipboardHelper)
        .copyString(str);
      return true;
    } catch (e) {
      Zotero.logError(e);
      return false;
    }
  }
  function copyAndToast(str, label) {
    toast(copyText(str) ? (label || "已复制") : "复制失败");
  }

  function setBusy(btn, busy) {
    if (!btn) return;
    if (busy) btn.setAttribute("disabled", "true");
    else btn.removeAttribute("disabled");
  }

  // ---------- token ----------
  function maskedToken() {
    let t = String(P("token") || "");
    return t ? t.slice(0, 4) + "••••••••" + t.slice(-2) : "";
  }
  function refreshTokenField() {
    let input = $("ab-token");
    if (!input) return;
    input.value = state.tokenVisible ? String(P("token") || "") : maskedToken();
    let btn = $("ab-toggle-token");
    if (btn) btn.setAttribute("label", state.tokenVisible ? "隐藏" : "显示");
  }

  // ---------- status ----------
  function refreshStatus() {
    let ver = $("zam-version");
    if (ver) ver.textContent = "v" + (api().version || "");
    let url = $("zam-url");
    if (url) url.textContent = api().baseUrl();
    let st = $("zam-status");
    if (st) {
      let on = !!P("enabled");
      st.classList.toggle("off", !on);
      st.textContent = on ? "运行中" : "已停用";
    }
  }

  // ---------- clients ----------
  function badgeFor(s) {
    if (s.error) return { cls: "bad", text: "出错", title: s.error };
    if (!s.detected && !s.pathExists) return { cls: "", text: "未安装" };
    if (s.configured && s.tokenMatch === false) return { cls: "warn", text: "令牌过期" };
    if (s.configured) return { cls: "ok", text: "已接入" };
    return { cls: "", text: "未接入" };
  }

  function renderClients() {
    let box = $("zam-clients");
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);

    let installed = 0;
    let connected = 0;
    for (let s of state.statuses) {
      if (s.detected) installed++;
      if (s.configured) connected++;
      let row = x("hbox", { class: "zam-client", align: "center" });
      row.appendChild(h("span", { class: "zam-name" }, s.label));

      let b = badgeFor(s);
      let badge = h("span", { class: "zam-badge " + b.cls }, b.text);
      if (b.title) badge.setAttribute("title", b.title);
      row.appendChild(badge);
      row.appendChild(x("spacer", { flex: "1" }));

      let client = state.clientMap.get(s.id);
      if (s.detected || s.pathExists) {
        if (s.configured) {
          row.appendChild(
            x("button", {
              label: "更新",
              title: s.path,
              oncommand: () => writeOne(client, false),
            })
          );
          row.appendChild(
            x("button", {
              label: "撤销",
              title: s.path,
              oncommand: () => writeOne(client, true),
            })
          );
        } else {
          row.appendChild(
            x("button", {
              label: "接入",
              title: s.path || "",
              oncommand: () => writeOne(client, false),
            })
          );
        }
      }
      box.appendChild(row);
    }

    let summary = $("zam-client-summary");
    if (summary) {
      summary.textContent = state.loadError
        ? "检测失败：" + state.loadError
        : `${installed} 个已安装 · ${connected} 个已接入`;
    }
    renderSkillState();
  }

  async function loadClients(force) {
    try {
      let clients = await api().clients(!!force);
      state.clientMap = new Map(clients.map((c) => [c.id, c]));
      state.statuses = await api().clientStatuses(!!force);
      state.loadError = "";
    } catch (e) {
      state.loadError = String((e && e.message) || e);
      try {
        Zotero.logError(e);
      } catch (e2) {}
      state.statuses = [];
    }
    renderClients();
  }

  async function writeOne(client, remove) {
    if (!client) return toast("未找到客户端定义");
    try {
      let r = await api().applyClientConfig(client, { remove });
      if (!r.ok) return toast(r.error || "写入失败");
      toast(remove ? "已撤销" : r.unchanged ? "已是最新" : "已写入");
    } catch (e) {
      Zotero.logError(e);
      toast("写入失败");
    }
    loadClients(true);
  }

  async function applyAll() {
    let btn = $("ab-apply-all");
    if (state.busy) return;
    state.busy = true;
    setBusy(btn, true);
    try {
      let results = await api().applyAllClientConfigs();
      let ok = results.filter((r) => r.ok).length;
      let failed = results.filter((r) => !r.ok && !r.skipped);
      let msg = `已接入 ${ok} 个`;
      if (failed.length) {
        let first = failed[0];
        msg += `，${failed.length} 个失败（${first.id}: ${first.error || "写入失败"}）`;
      }
      toast(msg);
    } catch (e) {
      Zotero.logError(e);
      toast("接入失败");
    }
    state.busy = false;
    setBusy(btn, false);
    loadClients(true);
  }

  // ---------- skill ----------
  async function renderSkillState() {
    let out = $("zam-skill-result");
    if (!out) return;
    let states = [];
    try {
      states = await api().skillState();
    } catch (e) {}
    let installed = states.filter((s) => s.installed);
    out.textContent = installed.length ? `skill：${installed.length} 个客户端` : "skill：未安装";
  }

  // ---------- connection test ----------
  async function runTest() {
    let out = $("zam-test-result");
    let btn = $("ab-test");
    if (state.busy) return;
    state.busy = true;
    setBusy(btn, true);
    if (out) out.textContent = "测试中…";

    let deep = null;
    try {
      deep = await api().testConnection();
    } catch (e) {
      deep = { error: String((e && e.message) || e) };
    }
    let msg;
    if (deep && deep.mcpOk) msg = `连接正常 · ${deep.ms}ms · ${deep.tools} 个工具`;
    else if (deep && deep.nodeOk) msg = `失败：${deep.error || "未知错误"}`;
    else msg = `未完成：${(deep && deep.error) || "无法启动 node"}`;
    if (out) out.textContent = msg;
    state.busy = false;
    setBusy(btn, false);
  }

  // ---------- advanced ----------
  function bindCheck(id, key, cb) {
    let node = $(id);
    if (!node) return;
    node.checked = P(key) === undefined ? true : !!P(key);
    node.addEventListener("command", () => {
      S(key, !!node.checked);
      if (cb) cb();
    });
  }
  function bindInput(id, key, numeric) {
    let node = $(id);
    if (!node) return;
    let v = P(key);
    node.value = v === undefined || v === null ? "" : String(v);
    node.addEventListener("change", () => {
      if (numeric) {
        let n = parseInt(node.value, 10);
        S(key, isNaN(n) ? 0 : n);
      } else {
        S(key, node.value.trim());
      }
    });
  }

  function curlExample() {
    const t = String(P("token") || "");
    const u = api().baseUrl();
    return [
      `curl ${u}/ping`,
      `curl -H "Authorization: Bearer ${t}" "${u}/search?q=the&limit=5"`,
      `curl -H "Authorization: Bearer ${t}" "${u}/item/ABCD1234/fulltext?maxChars=20000"`,
    ].join("\n");
  }

  async function refreshAdvancedInfo() {
    let auditPath = $("zam-audit-path");
    if (auditPath) auditPath.textContent = api().auditPath();
    let bridgePath = $("zam-bridge-path");
    if (bridgePath) bridgePath.textContent = api().bridgePath();
    let nodeInfo = $("zam-node-path");
    if (nodeInfo) {
      try {
        let found = await api().nodeFound();
        nodeInfo.textContent = found ? "node：" + (await api().nodePath()) : "node：未找到，配置里用命令名 node";
      } catch (e) {}
    }
  }

  function openPath(target) {
    try {
      Zotero.File.reveal(target);
    } catch (e) {
      try {
        Zotero.launchFile(target);
      } catch (e2) {
        Zotero.logError(e2);
      }
    }
  }

  // ---------- init ----------
  function init() {
    if (state.initialized) return;
    state.initialized = true;
    // XUL sometimes dispatches a command event while the pane is being inserted;
    // ignore commands for a moment so buttons never fire on their own.
    state.armedAt = Date.now() + 400;
    let root = $("zotero-agent-mcp-prefs");
    if (root) {
      root.addEventListener(
        "command",
        (ev) => {
          if (Date.now() < state.armedAt) {
            ev.stopPropagation();
            ev.preventDefault();
          }
        },
        true
      );
    }

    let logo = $("zam-logo");
    if (logo) {
      try {
        logo.setAttribute("src", api().rootURI + "icons/prefs-64.png");
      } catch (e) {}
    }

    refreshStatus();
    refreshTokenField();

    $("ab-enabled")?.addEventListener("command", refreshStatus);

    $("ab-toggle-token")?.addEventListener("command", () => {
      state.tokenVisible = !state.tokenVisible;
      refreshTokenField();
    });
    $("ab-copy-token")?.addEventListener("command", () =>
      copyAndToast(String(P("token") || ""), "令牌已复制")
    );
    $("ab-regen")?.addEventListener("command", () => {
      let ok = Services.prompt.confirm(window, "Zotero-Agent-MCP", "重置令牌后会自动改写已接入的客户端配置。继续？");
      if (!ok) return;
      api().regenerateToken();
      refreshTokenField();
      toast("令牌已重置，正在同步客户端");
      setTimeout(() => loadClients(true), 600);
    });

    $("ab-apply-all")?.addEventListener("command", applyAll);
    $("ab-test")?.addEventListener("command", runTest);
    bindCheck("ab-autosync", "autoSync");

    $("ab-skill-install")?.addEventListener("command", async () => {
      let btn = $("ab-skill-install");
      setBusy(btn, true);
      try {
        let results = await api().installSkills();
        let ok = results.filter((r) => r.ok).length;
        toast(`skill 已安装到 ${ok} 个`);
      } catch (e) {
        Zotero.logError(e);
        toast("安装失败");
      }
      setBusy(btn, false);
      renderSkillState();
    });
    $("ab-skill-undo")?.addEventListener("command", async () => {
      try {
        let results = await api().uninstallSkills();
        toast(`已撤销 ${results.filter((r) => r.ok).length} 处`);
      } catch (e) {
        toast("撤销失败");
      }
      renderSkillState();
    });

    $("ab-adv-toggle")?.addEventListener("command", () => {
      let box = $("zam-advanced");
      if (!box) return;
      let show = box.hasAttribute("hidden");
      if (show) box.removeAttribute("hidden");
      else box.setAttribute("hidden", "true");
      $("ab-adv-toggle").setAttribute("label", show ? "收起" : "展开");
      if (show) refreshAdvancedInfo();
    });

    bindCheck("ab-scope-read", "scope-read");
    bindCheck("ab-scope-fulltext", "scope-fulltext");
    bindCheck("ab-scope-annotations", "scope-annotations");
    bindCheck("ab-scope-export", "scope-export");
    bindCheck("ab-scope-write", "scope-write");
    bindCheck("ab-scope-files", "scope-files");
    bindCheck("ab-audit", "audit");
    bindInput("ab-libs", "allowedLibraries", false);
    bindInput("ab-rate", "rateLimit", true);

    $("ab-revert-all")?.addEventListener("command", async () => {
      let ok = Services.prompt.confirm(window, "Zotero-Agent-MCP", "从所有客户端配置中移除 zotero-agent（其余条目保留）。继续？");
      if (!ok) return;
      try {
        let results = await api().revertAllClientConfigs();
        toast(`已撤销 ${results.filter((r) => r.ok).length} 个`);
      } catch (e) {
        toast("撤销失败");
      }
      loadClients(true);
    });
    $("ab-copy-mcp")?.addEventListener("command", async () => {
      try {
        let entry = await api().serverEntry("node");
        copyAndToast(JSON.stringify({ mcpServers: { "zotero-agent": entry } }, null, 2), "已复制");
      } catch (e) {
        toast("生成失败");
      }
    });
    $("ab-copy-curl")?.addEventListener("command", () => copyAndToast(curlExample(), "已复制"));
    $("ab-open-bridge")?.addEventListener("command", () => openPath(api().bridgePath()));
    $("ab-open-audit")?.addEventListener("command", () => openPath(api().auditPath()));

    window.requestAnimationFrame(() => loadClients(false));
  }

  function start() {
    if (window.document.getElementById("ab-enabled")) return init();
    let observer = new MutationObserver(() => {
      if (!window.document.getElementById("ab-enabled")) return;
      observer.disconnect();
      init();
    });
    try {
      observer.observe(window.document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      return;
    }
    window.setTimeout(() => {
      try {
        observer.disconnect();
      } catch (e) {}
    }, 10000);
  }

  function surfaceError(msg) {
    try {
      let box = window.document.getElementById("zam-client-summary");
      if (box) box.textContent = "初始化失败：" + msg;
    } catch (e) {}
  }

  window.addEventListener("error", (ev) => surfaceError((ev && ev.message) || "unknown"));

  try {
    start();
  } catch (e) {
    surfaceError(String((e && e.message) || e));
    try {
      Zotero.logError(e);
    } catch (e2) {}
  }
})();
