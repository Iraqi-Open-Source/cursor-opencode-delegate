// Smoke test: talks MCP to server.mjs using a fake opencode binary.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocd-'));
spawnSync('git', ['init', '-q'], { cwd: tmp });

const fake = path.join(here, 'fake-opencode.mjs');
const wrapper = path.join(tmp, process.platform === 'win32' ? 'oc.cmd' : 'oc');
fs.writeFileSync(wrapper, process.platform === 'win32'
  ? `@echo off\r\nnode "${fake}" %*\r\n`
  : `#!/bin/sh\nexec node "${fake}" "$@"\n`, { mode: 0o755 });

const srv = spawn('node', [path.join(here, '..', 'src', 'server.mjs')], {
  env: { ...process.env, OPENCODE_BIN: wrapper, OPENCODE_DELEGATE_CWD: tmp },
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = ''; const waiters = new Map();
srv.stdout.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.id && waiters.has(m.id)) waiters.get(m.id)(m);
  }
});
let n = 0;
const rpc = (method, params) => new Promise((res) => { const id = ++n; waiters.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const assert = (c, msg) => { if (!c) { console.error('FAIL:', msg); srv.kill(); process.exit(1); } console.log('ok  -', msg); };

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
assert(init.result.serverInfo.name === 'opencode-delegate', 'initialize');
const list = await rpc('tools/list', {});
assert(list.result.tools.length === 3, 'tools/list returns 3 tools');
const doc = await rpc('tools/call', { name: 'opencode_doctor', arguments: {} });
assert(doc.result.content[0].text.includes('0.0.0-fake'), 'doctor finds opencode');
const models = await rpc('tools/call', { name: 'opencode_models', arguments: { filter: 'go' } });
assert(models.result.content[0].text.includes('opencode-go/fake-go') && !models.result.content[0].text.includes('anthropic'), 'models + filter');
const run = await rpc('tools/call', { name: 'opencode_delegate', arguments: { task: 'create hello.txt', model: 'opencode/fake-lite', acceptance_criteria: 'file exists' } });
const t = run.result.content[0].text;
assert(!run.result.isError, 'delegate succeeded');
assert(t.includes('--model') && t.includes('opencode/fake-lite'), 'model flag passed');
assert(t.includes('?? hello.txt'), 'git changes reported');
const bad = await rpc('tools/call', { name: 'opencode_delegate', arguments: { task: 'x', model: 'bad model; rm -rf' } });
assert(bad.result.isError, 'rejects invalid model');
const esc = await rpc('tools/call', { name: 'opencode_delegate', arguments: { task: 'x', cwd: '../../etc' } });
assert(esc.result.isError, 'rejects cwd outside workspace');
console.log('\nAll smoke tests passed.');
srv.kill(); process.exit(0);
