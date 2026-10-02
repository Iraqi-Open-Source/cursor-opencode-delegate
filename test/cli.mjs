// CLI test: init / uninstall in a temp project (all three modes).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.mjs');
const run = (...a) => spawnSync('node', [cli, ...a], { encoding: 'utf8' });
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-cli-'));
const mcpFile = path.join(proj, '.cursor', 'mcp.json');
fs.mkdirSync(path.join(proj, '.cursor'));
fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));

assert(run('--version').stdout.trim() === JSON.parse(fs.readFileSync(path.join(path.dirname(cli), '..', 'package.json'))).version, '--version');

let r = run('init', proj, '--mode', 'npx', '--model', 'opencode/x');
assert(r.status === 0, 'init npx exits 0');
let j = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
assert(j.mcpServers.other && j.mcpServers['opencode-delegate'], 'keeps existing servers, adds ours');
assert(j.mcpServers['opencode-delegate'].env.OPENCODE_DEFAULT_MODEL === 'opencode/x', 'model env set');
assert(fs.existsSync(path.join(proj, '.cursor/rules/opencode-delegate.mdc')), 'rule copied');
assert(fs.existsSync(path.join(proj, '.cursor/commands/delegate.md')), 'commands copied');

run('init', proj, '--mode', 'global');
j = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
assert(JSON.stringify(j.mcpServers['opencode-delegate']).includes('serve'), 'global mode entry');
run('init', proj, '--mode', 'local');
j = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
assert(j.mcpServers['opencode-delegate'].args[0].includes('node_modules/cursor-opencode-delegate/src/server.mjs'), 'local mode entry');
assert(run('init', proj, '--mode', 'bogus').status !== 0, 'rejects bad mode');

r = run('uninstall', proj);
j = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
assert(!j.mcpServers['opencode-delegate'] && j.mcpServers.other, 'uninstall removes only ours');
assert(!fs.existsSync(path.join(proj, '.cursor/rules/opencode-delegate.mdc')), 'uninstall removes rule');
console.log('\nAll CLI tests passed.');
