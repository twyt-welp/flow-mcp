// Adds the C3 channel's own Flow connector ("flow-c3") to Claude's settings, next to the existing flow connector.
// Run by "Add C3 connector.cmd" with Claude closed. It copies the existing flow-mcp entry (same node, same
// dist/index.js) and gives the copy the C3 settings: its own Chrome profile and Google sign-in, Chrome port, Studio
// port and video folder (the same values as "Flow C3 settings.cmd"). The settings file is backed up first.
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const appdata = process.env.APPDATA ?? join(home, "AppData", "Roaming");
const local = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
// Claude from claude.ai keeps its settings in AppData\Roaming\Claude; the Microsoft Store build keeps them in its package folder.
const candidates = [join(appdata, "Claude", "claude_desktop_config.json")];
const packages = join(local, "Packages");
if (existsSync(packages))
  for (const p of readdirSync(packages).filter((d) => /^Claude_/i.test(d))) candidates.push(join(packages, p, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
const files = candidates.filter((f) => existsSync(f));
if (!files.length) {
  console.log("Couldn't find Claude's settings file. Looked in:\n  " + candidates.join("\n  "));
  process.exit(1);
}

const c3env = {
  FLOW_MCP_NAME: "C3",
  FLOW_MCP_HOME: join(home, ".flow-mcp-c3"),
  FLOW_MCP_CDP_PORT: "9334",
  FLOW_MCP_PORT: "8788",
  FLOW_MCP_OUTPUT: join(home, "youtube-studio", "c3-videos"),
  FLOW_MCP_OTHER_HOME: join(home, ".flow-mcp"),
};

for (const file of files) {
  const config = JSON.parse(readFileSync(file, "utf8"));
  const servers = (config.mcpServers ??= {});
  const [name, flow] = Object.entries(servers).find(([n, s]) => n !== "flow-c3" && JSON.stringify(s.args ?? []).replace(/\\\\/g, "/").includes("flow-mcp")) ?? [];
  if (!flow) {
    console.log(`${file}\n  has no flow-mcp connector to copy, so nothing was changed.`);
    continue;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  copyFileSync(file, file.replace(/\.json$/, `.before-c3-${stamp}.json`));
  // The C5 connector's own home (its recorded Google account is what C3 must not use), if it was given one.
  const other = flow.env?.FLOW_MCP_HOME ?? c3env.FLOW_MCP_OTHER_HOME;
  servers["flow-c3"] = { ...structuredClone(flow), env: { ...(flow.env ?? {}), ...c3env, FLOW_MCP_OTHER_HOME: other } };
  writeFileSync(file, JSON.stringify(config, null, 2));
  console.log(`Added "flow-c3" (a copy of "${name}" with the C3 settings) to\n  ${file}`);
}
console.log("\nNow start Claude again. Then double-click \"Sign in to Flow C3\" and sign in with the C3 Google account.");
