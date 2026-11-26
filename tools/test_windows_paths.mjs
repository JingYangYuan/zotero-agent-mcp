/* Regression tests for Windows path normalization, client detection paths,
 * UTF-8 BOM JSON merging, Codex TOML escaping/CRLF, and atomic writes.
 * Run: node tools/test_windows_paths.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "plugin", "zotero-agent-mcp.js"), "utf8");
const clientsReg = JSON.parse(fs.readFileSync(path.join(root, "plugin", "clients.json"), "utf8"));

function sliceBetween(startMarker, endMarker, includeEnd = false) {
  const s = src.indexOf(startMarker);
  const e = src.indexOf(endMarker, s);
  if (s < 0 || e < 0) throw new Error(`Markers not found: ${startMarker} .. ${endMarker}`);
  return src.slice(s, includeEnd ? e + endMarker.length : e);
}

const pathBlock = sliceBetween("  function envVar(name) {", "  this.expandPath = expandPath;", true);
const statusBlock = sliceBetween("  function clientPaths(c) {", "  this.clientStatus = clientStatus;", true);
const mergeBlock = sliceBetween("  function skipWs(text, i) {", "  async function configTargetPath(c) {");
const applyBlock = sliceBetween("  async function configTargetPath(c) {", "  this.applyClientConfig = applyClientConfig;", true);

function createEnv({ isWin, homeDir, env = {}, specialDirs = {}, files = new Map(), dirs = new Set(), failTmpPath = false }) {
  const Zotero = { isWin, isMac: false, debug() {} };
  const PathUtils = {
    join(base, seg) {
      if (isWin && (String(base).includes("/") || String(seg).includes("/"))) {
        const err = new Error(`Could not parse path '${base}' (NS_ERROR_FILE_UNRECOGNIZED_PATH)`);
        throw err;
      }
      if (String(seg).includes("/") || String(seg).includes("\\")) {
        throw new Error("NS_ERROR_FILE_UNRECOGNIZED_PATH");
      }
      const sep = isWin ? "\\" : "/";
      const b = String(base);
      return (b.endsWith(sep) ? b : b + sep) + seg;
    },
    parent(p) {
      if (isWin && String(p).includes("/")) {
        throw new Error(`Could not parse path '${p}' (NS_ERROR_FILE_UNRECOGNIZED_PATH)`);
      }
      const sep = isWin ? "\\" : "/";
      const i = p.lastIndexOf(sep);
      if (i <= 0) return p;
      const out = p.slice(0, i);
      return isWin && /^[A-Za-z]:$/.test(out) ? out + "\\" : out;
    },
  };
  const Components = {
    interfaces: { nsIEnvironment: "nsIEnvironment", nsIFile: "nsIFile" },
    classes: {
      "@mozilla.org/process/environment;1": {
        getService() {
          return {
            exists: (k) => Object.prototype.hasOwnProperty.call(env, k),
            get: (k) => env[k] || "",
          };
        },
      },
    },
  };
  const Services = {
    dirsvc: {
      get(key) {
        if (!Object.prototype.hasOwnProperty.call(specialDirs, key)) throw new Error("missing dirsvc key");
        return { path: specialDirs[key] };
      },
    },
  };
  const assertWinPath = (p) => {
    if (isWin && String(p).includes("/")) {
      throw new Error(`could not parse path '${p}' (NS_ERROR_FILE_UNRECOGNIZED_PATH)`);
    }
  };
  const IOUtils = {
    async exists(p) {
      assertWinPath(p);
      return files.has(p) || dirs.has(p);
    },
    async stat(p) {
      assertWinPath(p);
      if (!files.has(p)) throw new Error(`NotFoundError: ${p}`);
      return { size: Buffer.byteLength(files.get(p), "utf8") };
    },
    async readUTF8(p) {
      assertWinPath(p);
      if (!files.has(p)) throw new Error(`NotFoundError: ${p}`);
      return files.get(p);
    },
    async writeUTF8(p, text, opts) {
      assertWinPath(p);
      if (opts && opts.tmpPath) {
        assertWinPath(opts.tmpPath);
        if (failTmpPath) throw new Error("Simulated tmpPath unsupported");
      }
      files.set(p, text);
    },
    async copy(from, to) {
      assertWinPath(from);
      assertWinPath(to);
      if (!files.has(from)) throw new Error(`NotFoundError: ${from}`);
      files.set(to, files.get(from));
    },
    async move(from, to) {
      assertWinPath(from);
      assertWinPath(to);
      if (!files.has(from)) throw new Error(`NotFoundError: ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async remove(p) {
      assertWinPath(p);
      files.delete(p);
    },
  };
  const getPref = (k) => (k === "token" ? "TEST_TOKEN_123" : undefined);
  const homeDirPath = () => homeDir;
  const serverEntry = async () => ({
    type: "stdio",
    command: isWin ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/local/bin/node",
    args: [isWin ? "C:\\Users\\YJY\\Zotero\\zotero-agent-mcp\\zotero-agent-mcp.mjs" : "/Users/yjy/Zotero/zotero-agent-mcp/zotero-agent-mcp.mjs"],
    env: {
      ZOTERO_AGENT_URL: "http://127.0.0.1:23119/zotero-agent-mcp",
      ZOTERO_AGENT_TOKEN: "TEST_TOKEN_123",
    },
  });

  const factory = new Function(
    "Zotero",
    "PathUtils",
    "Components",
    "Services",
    "IOUtils",
    "getPref",
    "homeDirPath",
    "serverEntry",
    [
      pathBlock,
      mergeBlock,
      statusBlock,
      applyBlock,
      "return { normalizePath, joinPath, parentDirPath, expandPath, clientPaths, clientDetectPaths, clientStatus, applyClientConfig, tomlHeaderRe, tomlStripSection, tomlSetSection, jsonSetEntry, jsonCreateEntry, isParseableJson };",
    ].join("\n")
  );
  const api = factory.call({}, Zotero, PathUtils, Components, Services, IOUtils, getPref, homeDirPath, serverEntry);
  return { api, files, dirs };
}

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("PASS ", name);
  } else {
    fail++;
    console.log("FAIL ", name, detail === undefined ? "" : String(detail).slice(0, 300));
  }
}

// 1. Windows path normalization & expansion across all clients in clients.json
{
  const winEnv = createEnv({
    isWin: true,
    homeDir: "C:\\Users\\YJY",
    env: {
      USERPROFILE: "C:\\Users\\YJY",
      APPDATA: "C:\\Users\\YJY\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\YJY\\AppData\\Local",
    },
    specialDirs: {
      AppData: "C:\\Users\\YJY\\AppData\\Roaming",
      LocalAppData: "C:\\Users\\YJY\\AppData\\Local",
    },
  });
  const { api } = winEnv;

  for (const rawClient of clientsReg.clients) {
    const c = Object.assign({ key: "zotero-agent", format: "json-mcpServers", prefer: "node" }, rawClient);
    const paths = api.clientPaths(c);
    const detects = api.clientDetectPaths(c);
    ok(`win32 ${c.id}: has >=1 config path`, paths.length >= 1, JSON.stringify(paths));
    ok(`win32 ${c.id}: has >=1 detect path`, detects.length >= 1, JSON.stringify(detects));
    const skill = c.skillDir ? [api.expandPath(c.skillDir)] : [];
    const all = [...paths, ...detects, ...skill];
    for (const p of all) {
      ok(
        `win32 ${c.id}: clean Windows path (${p})`,
        !p.includes("/") && !/%[A-Za-z_]+%/.test(p) && !api.parentDirPath(p).includes("/"),
        p
      );
      ok(
        `win32 ${c.id}: tmp/bak path has no '/'`,
        !(p + ".zotero-agent-mcp.tmp").includes("/") && !(p + ".zotero-agent-mcp.bak").includes("/"),
        p
      );
    }
  }

  const byId = Object.fromEntries(clientsReg.clients.map((c) => [c.id, c]));
  ok(
    "win32 claude-code path",
    api.clientPaths(byId["claude-code"])[0] === "C:\\Users\\YJY\\.claude.json",
    api.clientPaths(byId["claude-code"])[0]
  );
  ok(
    "win32 claude-desktop path",
    api.clientPaths(byId["claude-desktop"])[0] === "C:\\Users\\YJY\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
    api.clientPaths(byId["claude-desktop"])[0]
  );
  ok(
    "win32 vs-code primary path",
    api.clientPaths(byId["vs-code"])[0] === "C:\\Users\\YJY\\AppData\\Roaming\\Code\\User\\mcp.json",
    api.clientPaths(byId["vs-code"])[0]
  );
  ok(
    "win32 opencode paths",
    JSON.stringify(api.clientPaths(byId["opencode"])) ===
      JSON.stringify([
        "C:\\Users\\YJY\\.config\\opencode\\opencode.json",
        "C:\\Users\\YJY\\AppData\\Roaming\\opencode\\opencode.json",
      ]),
    JSON.stringify(api.clientPaths(byId["opencode"]))
  );
  ok(
    "win32 workbuddy path",
    api.clientPaths(byId["workbuddy"])[0] === "C:\\Users\\YJY\\.workbuddy\\mcp.json",
    api.clientPaths(byId["workbuddy"])[0]
  );
  ok(
    "win32 antigravity paths",
    JSON.stringify(api.clientPaths(byId["antigravity"])) ===
      JSON.stringify([
        "C:\\Users\\YJY\\.gemini\\config\\mcp_config.json",
        "C:\\Users\\YJY\\.gemini\\antigravity\\mcp_config.json",
      ]),
    JSON.stringify(api.clientPaths(byId["antigravity"]))
  );
  ok(
    "win32 amp paths",
    JSON.stringify(api.clientPaths(byId["amp"])) ===
      JSON.stringify([
        "C:\\Users\\YJY\\.config\\amp\\settings.json",
        "C:\\Users\\YJY\\AppData\\Roaming\\amp\\settings.json",
      ]),
    JSON.stringify(api.clientPaths(byId["amp"]))
  );
  ok(
    "win32 trae paths",
    JSON.stringify(api.clientPaths(byId["trae"])) ===
      JSON.stringify([
        "C:\\Users\\YJY\\AppData\\Roaming\\Trae\\User\\mcp.json",
        "C:\\Users\\YJY\\AppData\\Roaming\\Trae CN\\User\\mcp.json",
        "C:\\Users\\YJY\\.trae\\mcp.json",
      ]),
    JSON.stringify(api.clientPaths(byId["trae"]))
  );
  ok(
    "win32 additional agents primary paths",
    api.clientPaths(byId["copilot-cli"])[0] === "C:\\Users\\YJY\\.copilot\\mcp-config.json" &&
      api.clientPaths(byId["factory"])[0] === "C:\\Users\\YJY\\.factory\\mcp.json" &&
      api.clientPaths(byId["kimi-code"])[0] === "C:\\Users\\YJY\\.kimi-code\\mcp.json" &&
      api.clientPaths(byId["omp"])[0] === "C:\\Users\\YJY\\.omp\\agent\\mcp.json" &&
      api.clientPaths(byId["commandcode"])[0] === "C:\\Users\\YJY\\.commandcode\\mcp.json" &&
      api.clientPaths(byId["windsurf"])[0] === "C:\\Users\\YJY\\.codeium\\windsurf\\mcp_config.json" &&
      api.clientPaths(byId["kiro"])[0] === "C:\\Users\\YJY\\.kiro\\settings\\mcp.json"
  );

  ok("win32 skips Unix /Applications path", api.expandPath("/Applications/Claude.app") === "");
  ok("win32 skips unset env placeholder", api.expandPath("%UNSET_ZAM_VAR%/foo.json") === "");
  ok(
    "win32 preserves UNC path",
    api.normalizePath("\\\\server\\share/dir/file.json") === "\\\\server\\share\\dir\\file.json",
    api.normalizePath("\\\\server\\share/dir/file.json")
  );
  ok("win32 keeps drive root C:\\", api.normalizePath("C:/") === "C:\\", api.normalizePath("C:/"));
  ok(
    "win32 parentDirPath of C:\\foo is C:\\",
    api.parentDirPath("C:\\foo") === "C:\\",
    api.parentDirPath("C:\\foo")
  );
}

// 2. Unix path expansion stays slash-separated and skips %APPDATA%
{
  const unixEnv = createEnv({ isWin: false, homeDir: "/Users/yjy" });
  const { api } = unixEnv;
  ok("unix ~", api.expandPath("~") === "/Users/yjy");
  ok("unix ~/.claude.json", api.expandPath("~/.claude.json") === "/Users/yjy/.claude.json");
  ok("unix skips %APPDATA%/Claude", api.expandPath("%APPDATA%/Claude") === "");
  ok("unix keeps /Applications/Claude.app", api.expandPath("/Applications/Claude.app") === "/Applications/Claude.app");
}

// 3. clientStatus + applyClientConfig on simulated Windows filesystem (strict no-'/' IOUtils)
{
  const files = new Map([
    ["C:\\Users\\YJY\\.claude.json", '\uFEFF{\n  "numStartups": 5\n}\n'],
    ["C:\\Users\\YJY\\AppData\\Roaming\\Claude\\claude_desktop_config.json", "{}\r\n"],
    ["C:\\Users\\YJY\\.workbuddy\\mcp.json", '{"mcpServers":{"stata-mcp":{"command":"node"}}}\n'],
    ["C:\\Users\\YJY\\.config\\amp\\settings.json", '{"amp.updates":"auto"}\n'],
    [
      "C:\\Users\\YJY\\.codex\\config.toml",
      'model = "gpt-5"\r\n\r\n[mcp_servers.zotero-agent]\r\ncommand = "node.exe"\r\nargs = ["x"]\r\n\r\n[mcp_servers.zotero-agent.env]\r\nZOTERO_AGENT_TOKEN = "OLD_TOKEN"\r\n',
    ],
  ]);
  const dirs = new Set([
    "C:\\Users\\YJY\\.claude",
    "C:\\Users\\YJY\\AppData\\Roaming\\Claude",
    "C:\\Users\\YJY\\.workbuddy",
    "C:\\Users\\YJY\\.config\\amp",
    "C:\\Users\\YJY\\.codex",
  ]);
  const winFs = createEnv({
    isWin: true,
    homeDir: "C:\\Users\\YJY",
    env: { USERPROFILE: "C:\\Users\\YJY", APPDATA: "C:\\Users\\YJY\\AppData\\Roaming" },
    files,
    dirs,
  });
  const byId = Object.fromEntries(
    clientsReg.clients.map((c) => [c.id, Object.assign({ key: "zotero-agent", format: "json-mcpServers", prefer: "node" }, c)])
  );

  // Claude Code with UTF-8 BOM
  const stClaudeBefore = await winFs.api.clientStatus(byId["claude-code"]);
  ok("win32 BOM claude-code status has no parse error", !stClaudeBefore.error && stClaudeBefore.pathExists, stClaudeBefore.error);

  const wrClaude = await winFs.api.applyClientConfig(byId["claude-code"]);
  ok("win32 claude-code write succeeds", wrClaude.ok === true, wrClaude.error);
  const stClaudeAfter = await winFs.api.clientStatus(byId["claude-code"]);
  ok("win32 claude-code configured & tokenMatch=true", stClaudeAfter.configured && stClaudeAfter.tokenMatch === true);
  ok(
    "win32 claude-code backup created with backslash path",
    files.has("C:\\Users\\YJY\\.claude.json.zotero-agent-mcp.bak")
  );

  // Claude Desktop
  const wrDesktop = await winFs.api.applyClientConfig(byId["claude-desktop"]);
  ok("win32 claude-desktop write succeeds", wrDesktop.ok === true, wrDesktop.error);

  // WorkBuddy
  const wrWorkbuddy = await winFs.api.applyClientConfig(byId["workbuddy"]);
  ok("win32 workbuddy write succeeds", wrWorkbuddy.ok === true, wrWorkbuddy.error);
  const stWorkbuddy = await winFs.api.clientStatus(byId["workbuddy"]);
  ok("win32 workbuddy configured & tokenMatch=true", stWorkbuddy.configured && stWorkbuddy.tokenMatch === true);

  // Amp (amp.mcpServers format)
  const wrAmp = await winFs.api.applyClientConfig(byId["amp"]);
  ok("win32 amp write succeeds", wrAmp.ok === true, wrAmp.error);
  const stAmp = await winFs.api.clientStatus(byId["amp"]);
  ok("win32 amp configured & tokenMatch=true", stAmp.configured && stAmp.tokenMatch === true);

  // Codex CRLF + stale token detection + update + fallback move
  const stCodexBefore = await winFs.api.clientStatus(byId["codex"]);
  ok(
    "win32 codex CRLF detects configured & tokenMatch=false",
    stCodexBefore.configured === true && stCodexBefore.tokenMatch === false,
    JSON.stringify(stCodexBefore)
  );
  const wrCodex = await winFs.api.applyClientConfig(byId["codex"]);
  ok("win32 codex write succeeds", wrCodex.ok === true, wrCodex.error);
  const stCodexAfter = await winFs.api.clientStatus(byId["codex"]);
  ok(
    "win32 codex updated & tokenMatch=true",
    stCodexAfter.configured === true && stCodexAfter.tokenMatch === true,
    JSON.stringify(stCodexAfter)
  );

  // Fallback atomic move path when { tmpPath } throws
  const fallbackFs = createEnv({
    isWin: true,
    homeDir: "C:\\Users\\YJY",
    env: { USERPROFILE: "C:\\Users\\YJY" },
    files: new Map([["C:\\Users\\YJY\\.claude.json", "{}"]]),
    dirs: new Set(["C:\\Users\\YJY\\.claude"]),
    failTmpPath: true,
  });
  const wrFallback = await fallbackFs.api.applyClientConfig(byId["claude-code"]);
  ok(
    "win32 writeAtomic falls back to tmp + move cleanly",
    wrFallback.ok === true && !fallbackFs.files.has("C:\\Users\\YJY\\.claude.json.zotero-agent-mcp.tmp"),
    wrFallback.error
  );

  // tomlHeaderRe escapes regex metacharacters
  const reMeta = winFs.api.tomlHeaderRe("zotero.agent+1");
  ok(
    "tomlHeaderRe escapes metacharacters",
    reMeta.test("[mcp_servers.zotero.agent+1]") && !reMeta.test("[mcp_servers.zoteroXagent+1]")
  );

  // tomlStripSection handles CRLF cleanly
  const stripped = winFs.api.tomlStripSection(
    '[mcp_servers.other]\r\ncmd = "a"\r\n\r\n[mcp_servers.zotero-agent]\r\ncmd = "b"\r\n\r\n[mcp_servers.zotero-agent.env]\r\nX = "1"\r\n',
    "zotero-agent"
  );
  ok(
    "tomlStripSection strips CRLF target & env sections only",
    stripped.includes("[mcp_servers.other]") && !stripped.includes("zotero-agent"),
    stripped
  );
}

console.log(`\nRESULT: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
