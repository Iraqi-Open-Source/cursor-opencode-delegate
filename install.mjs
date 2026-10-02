#!/usr/bin/env node
/**
 * Installer for cursor-opencode-delegate
 *
 * Usage:
 *   node install.mjs [projectDir] [--global] [--model provider/model] [--agent name] [--force]
 *
 *   projectDir   target project (default: current directory)
 *   --global     register the MCP server in ~/.cursor/mcp.json (all projects)
 *                (default: <projectDir>/.cursor/mcp.json)
 *   --model X    set OPENCODE_DEFAULT_MODEL
 *   --agent X    set OPENCODE_DEFAULT_AGENT
 *   --force      overwrite existing rule/command files
 *
 * In every case the rule + slash commands are copied into <projectDir>/.cursor/
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--model', '--agent'].includes(argv[i - 1]));

const projectDir = path.resolve(positional[0] || process.cwd());
const isGlobal = flag('--global');
const force = flag('--force');

if (!fs.existsSync(projectDir)) {
  console.error(`Project dir not found: ${projectDir}`);
  process.exit(1);
}

// 1) MCP config ------------------------------------------------------------
const mcpPath = isGlobal
  ? path.join(os.homedir(), '.cursor', 'mcp.json')
  : path.join(projectDir, '.cursor', 'mcp.json');
fs.mkdirSync(path.dirname(mcpPath), { recursive: true });

let mcp = { mcpServers: {} };
if (fs.existsSync(mcpPath)) {
  try {
    mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    mcp.mcpServers ||= {};
  } catch {
    const bak = mcpPath + '.bak';
    fs.copyFileSync(mcpPath, bak);
    console.warn(`! Existing mcp.json was not valid JSON — backed up to ${bak}`);
  }
}

const env = { OPENCODE_DELEGATE_CWD: '${workspaceFolder}' };
if (opt('--model')) env.OPENCODE_DEFAULT_MODEL = opt('--model');
if (opt('--agent')) env.OPENCODE_DEFAULT_AGENT = opt('--agent');

mcp.mcpServers['opencode-delegate'] = {
  command: 'node',
  args: [path.join(here, 'server.mjs')],
  env,
};
fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
console.log(`✔ MCP server registered in ${mcpPath}`);

// 2) Rule + commands -------------------------------------------------------
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (fs.existsSync(d) && !force) console.log(`• kept existing ${path.relative(projectDir, d)} (use --force to overwrite)`);
    else {
      fs.copyFileSync(s, d);
      console.log(`✔ wrote ${path.relative(projectDir, d)}`);
    }
  }
}
copyDir(path.join(here, 'templates', '.cursor'), path.join(projectDir, '.cursor'));

console.log(`
Done. Next steps:
  1. Make sure OpenCode works:   opencode --version   and   opencode auth login
  2. Restart Cursor (or reload window), then open Settings → Tools & MCP
     and check that "opencode-delegate" is enabled (green dot).
  3. In Cursor chat try:  /plan-and-delegate add a /health endpoint with a test
`);
