#!/usr/bin/env node
/**
 * opencode-delegate — MCP server (stdio, zero dependencies)
 *
 * Lets Cursor's agent delegate small/simple implementation tasks to the
 * OpenCode CLI (`opencode run ...`), optionally choosing the model
 * (OpenCode Zen, OpenCode Go, or any provider/model OpenCode knows).
 *
 * Tools:
 *   - opencode_delegate : run a task with OpenCode, return output + git changes
 *   - opencode_models   : list models available in OpenCode (`opencode models`)
 *   - opencode_doctor   : check OpenCode is installed / show server config
 *
 * Env vars (all optional):
 *   OPENCODE_BIN                 path/name of the opencode binary   (default: opencode)
 *   OPENCODE_DELEGATE_CWD        project root                       (default: process.cwd())
 *   OPENCODE_DEFAULT_MODEL       e.g. opencode/<model>              (default: OpenCode's own default)
 *   OPENCODE_DEFAULT_AGENT       e.g. build                         (default: OpenCode's own default)
 *   OPENCODE_TIMEOUT_SECONDS     max run time per task              (default: 900)
 *   OPENCODE_MAX_OUTPUT_CHARS    max chars of output returned       (default: 20000)
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const SERVER_NAME = 'opencode-delegate';
const SERVER_VERSION = '1.0.0';

const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';
const DEFAULT_MODEL = (process.env.OPENCODE_DEFAULT_MODEL || '').trim();
const DEFAULT_AGENT = (process.env.OPENCODE_DEFAULT_AGENT || '').trim();
const DEFAULT_TIMEOUT_S = Number(process.env.OPENCODE_TIMEOUT_SECONDS || 900);
const MAX_OUTPUT = Number(process.env.OPENCODE_MAX_OUTPUT_CHARS || 20000);
const IS_WIN = process.platform === 'win32';

const log = (...a) => process.stderr.write('[opencode-delegate] ' + a.join(' ') + '\n');

// ───────────────────────── helpers ─────────────────────────

function workspaceRoot() {
  let c = process.env.OPENCODE_DELEGATE_CWD;
  // Cursor interpolates ${workspaceFolder}; if it didn't, fall back.
  if (!c || c.includes('${') || !fs.existsSync(c)) c = process.cwd();
  return path.resolve(c);
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n');
}

function truncateTail(s, max) {
  if (s.length <= max) return s;
  return `[... ${s.length - max} chars truncated ...]\n` + s.slice(s.length - max);
}

function quoteWin(a) {
  // Best-effort quoting for cmd.exe (needed to launch opencode.cmd).
  return '"' + String(a).replace(/"/g, '\\"').replace(/%/g, '%%') + '"';
}

function killTree(child) {
  try {
    if (IS_WIN) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else {
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref();
    }
  } catch {}
}

/** Run a process, collect output. onTick is called every 15s while running. */
function runProcess(bin, args, { cwd, timeoutMs, onTick }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(tick);
      resolve({ stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), timedOut, ms: Date.now() - started, ...r });
    };

    let child;
    try {
      child = spawn(IS_WIN ? quoteWin(bin) : bin, IS_WIN ? args.map(quoteWin) : args, {
        cwd,
        shell: IS_WIN,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
      });
    } catch (e) {
      return done({ code: -1, spawnError: e });
    }

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => done({ code: -1, spawnError: e }));
    child.on('close', (code) => done({ code }));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const tick = setInterval(() => onTick && onTick(Date.now() - started), 15000);
  });
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim();
}

function gitSnapshot(cwd) {
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return null;
  return { status: git(cwd, ['status', '--short']) || '' };
}

const MODEL_RE = /^[A-Za-z0-9._\-\/:@+]+$/;

// ───────────────────────── tool implementations ─────────────────────────

async function toolDelegate(args, ctx) {
  const root = workspaceRoot();
  const task = String(args.task || '').trim();
  if (!task) return err('`task` is required.');

  // working dir (must stay inside the workspace)
  let cwd = root;
  if (args.cwd) {
    cwd = path.resolve(root, String(args.cwd));
    if (cwd !== root && !cwd.startsWith(root + path.sep)) return err(`cwd must be inside the workspace (${root}).`);
    if (!fs.existsSync(cwd)) return err(`cwd does not exist: ${cwd}`);
  }

  const model = String(args.model || DEFAULT_MODEL || '').trim();
  if (model && !MODEL_RE.test(model)) return err(`Invalid model "${model}". Use provider/model (see opencode_models).`);
  const agent = String(args.agent || DEFAULT_AGENT || '').trim();
  if (agent && !/^[A-Za-z0-9._\-]+$/.test(agent)) return err(`Invalid agent "${agent}".`);

  const files = Array.isArray(args.files) ? args.files.map(String) : [];
  for (const f of files) {
    const abs = path.resolve(cwd, f);
    if (!fs.existsSync(abs)) return err(`File to attach not found: ${f}`);
  }

  // Build a focused, self-contained prompt.
  let prompt = task;
  if (args.context) prompt += `\n\n## Context\n${String(args.context).trim()}`;
  if (args.acceptance_criteria) prompt += `\n\n## Acceptance criteria\n${String(args.acceptance_criteria).trim()}`;
  prompt +=
    '\n\n## Rules\n' +
    '- Make only the changes required for this task; do not touch unrelated files.\n' +
    '- Follow the existing code style and conventions of this repo.\n' +
    '- When finished, reply with a short summary: files changed, and anything you could not verify.';

  // NOTE: message goes FIRST, array-style flags (--file) go LAST so they can't swallow it.
  const cliArgs = ['run', prompt];
  if (model) cliArgs.push('--model', model);
  if (agent) cliArgs.push('--agent', agent);
  if (args.variant) cliArgs.push('--variant', String(args.variant));
  if (args.session) cliArgs.push('--session', String(args.session));
  else if (args.continue_last) cliArgs.push('--continue');
  for (const f of files) cliArgs.push('--file', f);

  const timeoutS = Math.min(Math.max(Number(args.timeout_seconds) || DEFAULT_TIMEOUT_S, 10), 3600);
  const before = gitSnapshot(cwd);

  log(`run: model=${model || '(default)'} agent=${agent || '(default)'} cwd=${cwd}`);
  const res = await runProcess(OPENCODE_BIN, cliArgs, {
    cwd,
    timeoutMs: timeoutS * 1000,
    onTick: (ms) => ctx.progress && ctx.progress(Math.round(ms / 1000), `OpenCode running… ${Math.round(ms / 1000)}s`),
  });

  if (res.spawnError) {
    const notFound = res.spawnError.code === 'ENOENT';
    return err(
      notFound
        ? `Could not find the "${OPENCODE_BIN}" binary. Install OpenCode (https://opencode.ai) or set OPENCODE_BIN in mcp.json.`
        : `Failed to start OpenCode: ${res.spawnError.message}`
    );
  }

  const after = gitSnapshot(cwd);
  let changes = '(not a git repository — cannot list changes)';
  if (after) {
    const stat = git(cwd, ['diff', '--stat']) || '';
    const untracked = (after.status.split('\n').filter((l) => l.startsWith('??')).join('\n')) || '';
    const preexisting = before ? before.status.split('\n').filter(Boolean).length : 0;
    changes =
      `git status --short:\n${after.status || '(clean)'}\n\n` +
      `git diff --stat:\n${stat || '(no tracked-file diff)'}\n` +
      (untracked ? `\nNew untracked files:\n${untracked}\n` : '') +
      (preexisting ? `\n(note: ${preexisting} change(s) already existed before this run)\n` : '');
  }

  const ok = res.code === 0 && !res.timedOut;
  const out = truncateTail((res.stdout || '').trim() || '(no stdout)', MAX_OUTPUT);
  const errOut = (res.stderr || '').trim();
  const header = res.timedOut
    ? `⏱️ OpenCode TIMED OUT after ${timeoutS}s (killed).`
    : ok
    ? `✅ OpenCode finished in ${(res.ms / 1000).toFixed(1)}s.`
    : `❌ OpenCode exited with code ${res.code} after ${(res.ms / 1000).toFixed(1)}s.`;

  const text =
    `${header}\nmodel: ${model || '(OpenCode default)'}${agent ? `  agent: ${agent}` : ''}\n\n` +
    `--- OpenCode output ---\n${out}\n` +
    (errOut && !ok ? `\n--- stderr ---\n${truncateTail(errOut, 4000)}\n` : '') +
    `\n--- Workspace changes ---\n${changes}\n` +
    `Next: review the diff, run tests/lint, and fix or re-delegate if needed.`;

  return { content: [{ type: 'text', text }], isError: !ok };
}

async function toolModels(args) {
  const root = workspaceRoot();
  const cliArgs = ['models'];
  if (args.provider) {
    if (!/^[A-Za-z0-9._\-]+$/.test(String(args.provider))) return err('Invalid provider id.');
    cliArgs.push(String(args.provider));
  }
  if (args.refresh) cliArgs.push('--refresh');
  const res = await runProcess(OPENCODE_BIN, cliArgs, { cwd: root, timeoutMs: 60000 });
  if (res.spawnError) return err(`Could not run opencode: ${res.spawnError.message}`);
  if (res.code !== 0) return err(`opencode models failed (${res.code}): ${res.stderr || res.stdout}`);
  let lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (args.filter) {
    const f = String(args.filter).toLowerCase();
    lines = lines.filter((l) => l.toLowerCase().includes(f));
  }
  const text = lines.length
    ? `Available models (use as \`model\` = provider/model):\n\n${lines.slice(0, 400).join('\n')}` +
      (lines.length > 400 ? `\n… ${lines.length - 400} more (use filter/provider)` : '')
    : 'No models found. Run `opencode auth login` in a terminal to connect a provider (Zen / Go / others).';
  return { content: [{ type: 'text', text }] };
}

async function toolDoctor() {
  const root = workspaceRoot();
  const v = await runProcess(OPENCODE_BIN, ['--version'], { cwd: root, timeoutMs: 20000 });
  const lines = [
    `server: ${SERVER_NAME} v${SERVER_VERSION}`,
    `node: ${process.version} (${process.platform})`,
    `workspace: ${root}`,
    `opencode bin: ${OPENCODE_BIN}`,
    `default model: ${DEFAULT_MODEL || '(OpenCode default)'}`,
    `default agent: ${DEFAULT_AGENT || '(OpenCode default)'}`,
    `timeout: ${DEFAULT_TIMEOUT_S}s`,
    '',
  ];
  if (v.spawnError) lines.push(`❌ opencode NOT found: ${v.spawnError.message}`);
  else if (v.code !== 0) lines.push(`❌ opencode returned ${v.code}: ${v.stderr || v.stdout}`);
  else lines.push(`✅ opencode version: ${v.stdout.trim()}`);
  lines.push(`git repo: ${gitSnapshot(root) ? 'yes' : 'no'}`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function err(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

// ───────────────────────── MCP plumbing ─────────────────────────

const TOOLS = [
  {
    name: 'opencode_delegate',
    description:
      'Delegate a SMALL, well-scoped implementation task to the OpenCode CLI (cheap model) and return its output ' +
      'plus the resulting git changes. Use for lite tasks: boilerplate, simple CRUD, renames, small refactors, ' +
      'writing tests, docs/comments, config tweaks, single-file or few-file edits. Do NOT use for architecture, ' +
      'tricky debugging, security-sensitive code, or cross-cutting changes. Write the task to be self-contained.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Clear, self-contained instruction: what to implement and where.' },
        context: { type: 'string', description: 'Optional extra context: plan excerpt, relevant signatures, conventions.' },
        acceptance_criteria: { type: 'string', description: 'Optional "done" checklist (e.g. tests that must pass).' },
        model: {
          type: 'string',
          description:
            'Optional OpenCode model as provider/model (e.g. from opencode_models). Omit to use the configured default.',
        },
        agent: { type: 'string', description: 'Optional OpenCode agent, e.g. "build" (default) or "plan".' },
        variant: { type: 'string', description: 'Optional model variant / reasoning effort (provider-specific).' },
        files: { type: 'array', items: { type: 'string' }, description: 'Optional file paths (relative to cwd) to attach.' },
        session: { type: 'string', description: 'Optional OpenCode session ID to continue.' },
        continue_last: { type: 'boolean', description: 'Continue the last OpenCode session (for follow-up fixes).' },
        cwd: { type: 'string', description: 'Optional sub-directory (inside the workspace) to run in.' },
        timeout_seconds: { type: 'number', description: 'Optional max runtime (10–3600). Default 900.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'opencode_models',
    description: 'List models available in OpenCode (Zen, Go, and any connected providers) as provider/model.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Optional provider id to filter by (e.g. "opencode").' },
        filter: { type: 'string', description: 'Optional substring filter.' },
        refresh: { type: 'boolean', description: 'Refresh the model cache from models.dev.' },
      },
    },
  },
  {
    name: 'opencode_doctor',
    description: 'Check that OpenCode CLI is installed and show this delegate server\'s configuration.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyErr = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      case 'ping':
        return isRequest && reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS });
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments || {};
        const progressToken = params?._meta?.progressToken;
        const ctx = {
          progress: progressToken !== undefined
            ? (n, message) => send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken, progress: n, message } })
            : null,
        };
        let result;
        if (name === 'opencode_delegate') result = await toolDelegate(args, ctx);
        else if (name === 'opencode_models') result = await toolModels(args);
        else if (name === 'opencode_doctor') result = await toolDoctor();
        else return replyErr(id, -32602, `Unknown tool: ${name}`);
        return reply(id, result);
      }
      default:
        if (isRequest) return replyErr(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    log('error', e?.stack || e);
    if (isRequest) replyErr(id, -32603, String(e?.message || e));
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return log('bad JSON on stdin'); }
  handle(msg);
});
rl.on('close', () => process.exit(0));
log(`ready (workspace: ${workspaceRoot()})`);
