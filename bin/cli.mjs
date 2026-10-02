#!/usr/bin/env node
/**
 * cursor-opencode-delegate CLI
 *
 *   cursor-opencode-delegate init [dir] [options]   set up a project (MCP + rule + commands)
 *   cursor-opencode-delegate serve                  run the MCP server (used by Cursor)
 *   cursor-opencode-delegate doctor [dir]           check the setup
 *   cursor-opencode-delegate uninstall [dir]        remove from a project
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BIN_NAME = 'cursor-opencode-delegate';
const SERVER_KEY = 'opencode-delegate';
const IS_WIN = process.platform === 'win32';

const HELP = `
${PKG.name} v${PKG.version}
Plan in Cursor, delegate lite tasks to OpenCode CLI.

Usage:
  ${BIN_NAME} init [dir]        Set up a project: .cursor/mcp.json + rule + slash commands
  ${BIN_NAME} serve             Run the MCP server over stdio (Cursor starts this for you)
  ${BIN_NAME} doctor [dir]      Check Node, OpenCode and the project setup
  ${BIN_NAME} uninstall [dir]   Remove MCP entry, rule and commands from a project

init options:
  --mode <npx|global|local>   How Cursor launches the server (default: auto-detected)
                                npx    -> npx -y ${PKG.name}   (no install needed, slower start)
                                global -> ${BIN_NAME}         (after: npm i -g ${PKG.name})
                                local  -> node_modules/.bin    (after: npm i -D ${PKG.name})
  --user                      Register MCP in ~/.cursor/mcp.json (all projects) instead of the project
  --model <provider/model>    Default model for delegated tasks (OPENCODE_DEFAULT_MODEL)
  --agent <name>              Default OpenCode agent (OPENCODE_DEFAULT_AGENT)
  --no-rule                   Don't copy the rule / slash commands
  --force                     Overwrite existing rule / command files
  -v, --version               Print version
`;

// ─────────────── tiny arg parser ───────────────
const [cmd = 'help', ...rest] = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--mode', '--model', '--agent']);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    if (VALUE_FLAGS.has(a)) flags[a.slice(2)] = rest[++i];
    else flags[a.slice(2)] = true;
  } else positional.push(a);
}

// ─────────────── helpers ───────────────
function detectMode(projectDir) {
  const r = ROOT.split(path.sep).join('/');
  if (r.includes('/_npx/')) return 'npx';
  const localNm = path.join(projectDir, 'node_modules').split(path.sep).join('/');
  if (r.startsWith(localNm + '/')) return 'local';
  return 'global';
}

function buildServerEntry(mode, { user }) {
  const env = { OPENCODE_DELEGATE_CWD: '${workspaceFolder}' };
  if (flags.model) env.OPENCODE_DEFAULT_MODEL = flags.model;
  if (flags.agent) env.OPENCODE_DEFAULT_AGENT = flags.agent;

  const major = PKG.version.split('.')[0];
  let command, args;
  if (mode === 'npx') {
    [command, args] = IS_WIN
      ? ['cmd', ['/c', 'npx', '-y', `${PKG.name}@${major}`, 'serve']]
      : ['npx', ['-y', `${PKG.name}@${major}`, 'serve']];
  } else if (mode === 'global') {
    [command, args] = IS_WIN ? ['cmd', ['/c', BIN_NAME, 'serve']] : [BIN_NAME, ['serve']];
  } else if (mode === 'local') {
    // project-level config can use ${workspaceFolder}; user-level config needs an absolute path
    const server = user
      ? path.join(ROOT, 'src', 'server.mjs')
      : '${workspaceFolder}/node_modules/' + PKG.name + '/src/server.mjs';
    [command, args] = ['node', [server]];
  } else {
    fail(`Unknown --mode "${mode}". Use npx, global or local.`);
  }
  return { command, args, env };
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fs.copyFileSync(file, file + '.bak');
    console.warn(`! ${file} was not valid JSON — backed up to ${file}.bak`);
    return fallback;
  }
}

function copyTemplates(projectDir, force) {
  const src = path.join(ROOT, 'templates', '.cursor');
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const sp = path.join(s, e.name);
      const dp = path.join(d, e.name);
      if (e.isDirectory()) walk(sp, dp);
      else if (fs.existsSync(dp) && !force) console.log(`• kept existing ${path.relative(projectDir, dp)} (use --force to overwrite)`);
      else {
        fs.copyFileSync(sp, dp);
        console.log(`✔ wrote ${path.relative(projectDir, dp)}`);
      }
    }
  };
  walk(src, path.join(projectDir, '.cursor'));
}

function templateFiles() {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  walk(path.join(ROOT, 'templates', '.cursor'), '.cursor');
  return out;
}

function runBin(bin, args) {
  return spawnSync(bin, args, { encoding: 'utf8', shell: IS_WIN, timeout: 20000 });
}

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function resolveProject() {
  const dir = path.resolve(positional[0] || process.cwd());
  if (!fs.existsSync(dir)) fail(`Directory not found: ${dir}`);
  return dir;
}

// ─────────────── commands ───────────────
async function init() {
  const projectDir = resolveProject();
  const user = !!flags.user;
  const mode = flags.mode || detectMode(projectDir);

  const mcpPath = user
    ? path.join(os.homedir(), '.cursor', 'mcp.json')
    : path.join(projectDir, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  const mcp = readJson(mcpPath, {});
  mcp.mcpServers ||= {};
  mcp.mcpServers[SERVER_KEY] = buildServerEntry(mode, { user });
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');
  console.log(`✔ MCP server "${SERVER_KEY}" registered in ${mcpPath}  (mode: ${mode})`);

  if (!flags['no-rule']) copyTemplates(projectDir, !!flags.force);

  if (mode === 'local' && !fs.existsSync(path.join(projectDir, 'node_modules', PKG.name)) && !user)
    console.warn(`! Mode "local" but ${PKG.name} is not in ${projectDir}/node_modules — run: npm i -D ${PKG.name}`);

  console.log(`
Next steps:
  1. opencode --version && opencode auth login      (connect Zen / Go / other providers)
  2. Restart Cursor, then Settings → Tools & MCP → enable "${SERVER_KEY}" (green dot)
  3. In chat try: /plan-and-delegate add a /health endpoint with a test
  Check anytime with: ${BIN_NAME} doctor
`);
}

async function serve() {
  await import('../src/server.mjs');
}

function doctor() {
  const projectDir = resolveProject();
  let bad = 0;
  const ok = (m) => console.log(`✔ ${m}`);
  const no = (m) => { bad++; console.log(`✖ ${m}`); };

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  nodeMajor >= 18 ? ok(`Node ${process.version}`) : no(`Node ${process.version} — need >= 18`);

  const bin = process.env.OPENCODE_BIN || 'opencode';
  const v = runBin(bin, ['--version']);
  v.status === 0 && !v.error ? ok(`OpenCode ${v.stdout.trim()}`) : no(`"${bin}" not found or failing — install from https://opencode.ai`);

  if (v.status === 0) {
    const m = runBin(bin, ['models']);
    const n = m.status === 0 ? m.stdout.split('\n').filter(Boolean).length : 0;
    n > 0 ? ok(`${n} models available`) : no('no models — run: opencode auth login');
  }

  const g = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectDir, encoding: 'utf8' });
  g.stdout?.trim() === 'true' ? ok('git repository (changes will be reported)') : console.log('• not a git repo — diffs won\'t be reported');

  const projMcp = readJson(path.join(projectDir, '.cursor', 'mcp.json'), {});
  const userMcp = readJson(path.join(os.homedir(), '.cursor', 'mcp.json'), {});
  if (projMcp.mcpServers?.[SERVER_KEY]) ok('MCP entry found in project .cursor/mcp.json');
  else if (userMcp.mcpServers?.[SERVER_KEY]) ok('MCP entry found in ~/.cursor/mcp.json');
  else no(`no MCP entry — run: ${BIN_NAME} init`);

  fs.existsSync(path.join(projectDir, '.cursor', 'rules', 'opencode-delegate.mdc'))
    ? ok('rule .cursor/rules/opencode-delegate.mdc')
    : no(`rule missing — run: ${BIN_NAME} init`);

  console.log(bad ? `\n${bad} problem(s) found.` : '\nAll good. Restart Cursor if you just changed config.');
  process.exit(bad ? 1 : 0);
}

function uninstall() {
  const projectDir = resolveProject();
  for (const file of [path.join(projectDir, '.cursor', 'mcp.json'), path.join(os.homedir(), '.cursor', 'mcp.json')]) {
    if (!fs.existsSync(file)) continue;
    const j = readJson(file, null);
    if (j?.mcpServers?.[SERVER_KEY]) {
      delete j.mcpServers[SERVER_KEY];
      fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
      console.log(`✔ removed "${SERVER_KEY}" from ${file}`);
    }
  }
  for (const rel of templateFiles()) {
    const f = path.join(projectDir, rel);
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      console.log(`✔ deleted ${rel}`);
    }
  }
  console.log('Done. Restart Cursor. (To remove the package: npm rm -g / npm rm ' + PKG.name + ')');
}

switch (cmd) {
  case 'init': await init(); break;
  case 'serve': await serve(); break;
  case 'doctor': doctor(); break;
  case 'uninstall': uninstall(); break;
  case '-v': case '--version': case 'version': console.log(PKG.version); break;
  case 'help': case '-h': case '--help': console.log(HELP); break;
  default: console.error(`Unknown command: ${cmd}\n${HELP}`); process.exit(1);
}
