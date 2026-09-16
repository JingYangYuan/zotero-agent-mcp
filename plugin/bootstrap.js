/* Zotero-Agent-MCP — bootstrap
 * Pattern follows the Zotero 7+ bootstrap convention used by Jasminum 1.1.x
 * (verified working on Zotero 10.0.2).
 */

var AgentMCP = null;

async function startup({ id, version, resourceURI, rootURI }, reason) {
  await Zotero.initializationPromise;

  // String 'rootURI' introduced in Zotero 7
  if (!rootURI) {
    rootURI = resourceURI.spec;
  }

  var ctx = {
    Zotero,
    rootURI,
    id,
    version,
  };
  ctx._globalThis = ctx;

  // Core module (endpoints, auth, scopes, audit). Assigns ctx.AgentMCP.
  Services.scriptloader.loadSubScript(rootURI + "zotero-agent-mcp.js", ctx);
  // Bridge source as a JS string constant (jar:-safe, no fetch needed)
  Services.scriptloader.loadSubScript(rootURI + "bridge-source.js", ctx);

  AgentMCP = ctx.AgentMCP;
  await AgentMCP.startup({ id, version, rootURI, bridgeSource: ctx.BRIDGE_SRC });
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  if (typeof Zotero === "undefined") {
    Zotero = Components.classes["@zotero.org/Zotero;1"].getService(
      Components.interfaces.nsISupports,
    ).wrappedJSObject;
  }

  try {
    if (AgentMCP) {
      AgentMCP.shutdown();
    }
  } catch (e) {
    Zotero.logError(e);
  }
  AgentMCP = null;

  try {
    Cu.unload(rootURI + "zotero-agent-mcp.js");
  } catch (e) {}

  Components.classes["@mozilla.org/intl/stringbundle;1"]
    .getService(Components.interfaces.nsIStringBundleService)
    .flushBundles();
}

function install(data, reason) {}
function uninstall(data, reason) {}
