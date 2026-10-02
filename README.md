# cursor-opencode-delegate

**Plan in Cursor → implement lite tasks with OpenCode CLI (Zen / Go / any provider).**

Cursor's agent keeps the expensive thinking (planning, architecture, review).
When it detects a *lite* task (boilerplate, simple CRUD, small refactor, tests, docs…) it calls an MCP tool that runs
`opencode run "<task>" --model <provider/model>` in your project, then reviews the git diff.

```
 You ──► Cursor agent (plan, classify steps)
              │ LITE step
              ▼
        MCP tool: opencode_delegate ──► opencode run "…" [--model provider/model]
              ▲                                   │ edits files
              └──── output + git diff ◄───────────┘
        Cursor reviews, runs tests, fixes if needed
```

## What's inside

| Path | Purpose |
|---|---|
| `src/server.mjs` | MCP server (Node, **zero dependencies**). Tools: `opencode_delegate`, `opencode_models`, `opencode_doctor` |
| `bin/cli.mjs` | CLI: `init`, `serve`, `doctor`, `uninstall` |
| `templates/.cursor/rules/opencode-delegate.mdc` | Rule: teaches Cursor when to delegate (LITE vs HEAVY) and how to review |
| `templates/.cursor/commands/*.md` | Slash commands: `/delegate`, `/plan-and-delegate`, `/models` |

## Requirements

- **Node.js ≥ 18**
- **OpenCode CLI** installed and logged in:
  ```bash
  opencode --version
  opencode auth login      # connect OpenCode Zen / Go / other providers
  opencode models          # shows available models as provider/model
  ```
- **Cursor** with MCP support
- Git recommended (the tool reports changed files after each run)

## Install — pick one

### A) Global (recommended: fastest startup, works for every project)
```bash
npm install -g cursor-opencode-delegate
cd /path/to/your/project
cursor-opencode-delegate init
```

### B) Per project (version pinned in your repo)
```bash
cd /path/to/your/project
npm install -D cursor-opencode-delegate
npx cursor-opencode-delegate init
```

### C) No install (npx)
```bash
cd /path/to/your/project
npx cursor-opencode-delegate init --mode npx
```
Cursor will then launch the server with `npx -y cursor-opencode-delegate@1 serve` (first start is slower).

`init` writes:
- `.cursor/mcp.json` — registers the MCP server (existing servers are preserved)
- `.cursor/rules/opencode-delegate.mdc`
- `.cursor/commands/{delegate,plan-and-delegate,models}.md`

Then **restart Cursor**, open **Settings → Tools & MCP**, and confirm `opencode-delegate` is enabled (green dot, 3 tools).

### `init` options
```
--mode <npx|global|local>   how Cursor launches the server (auto-detected by default)
--user                      register in ~/.cursor/mcp.json (all projects) instead of the project
--model <provider/model>    default model for delegated tasks
--agent <name>              default OpenCode agent
--no-rule                   only register MCP, skip rule + commands
--force                     overwrite existing rule/command files
```

### Other commands
```bash
cursor-opencode-delegate doctor      # checks Node, OpenCode, models, git, MCP entry, rule
cursor-opencode-delegate uninstall   # removes MCP entry, rule and commands from the project
```

### Update
```bash
npm update -g cursor-opencode-delegate        # global
npm update cursor-opencode-delegate           # per project
cursor-opencode-delegate init --force         # refresh the rule/commands (overwrites your edits!)
```

## Using it

### 1. Automatic (recommended)
Just talk to Cursor's agent normally. The rule makes it:
1. plan the work and label each step **LITE** or **HEAVY**,
2. delegate LITE steps to OpenCode (`DELEGATION_MODE: auto`), or ask you first (`confirm`),
3. review the diff and run tests, fixing or re-delegating when needed.

Example prompts:
```
Plan and implement a /health endpoint with a unit test.
Add JSDoc to all exported functions in src/utils.  (→ lite, delegated)
Redesign the auth flow to use refresh tokens.       (→ heavy, Cursor does it itself)
```

### 2. Slash commands
| Command | What it does |
|---|---|
| `/delegate <task>` | Force this task to go to OpenCode. Add `use opencode/<model>` to pick a model |
| `/plan-and-delegate <task>` | Plan first, delegate LITE steps, implement HEAVY steps itself |
| `/models [filter]` | List OpenCode models (Zen, Go, others) |

### 3. Choosing a model (or not)
- **Not choosing:** omit it → OpenCode uses its configured default (or `OPENCODE_DEFAULT_MODEL` from `mcp.json`).
- **Choosing per task:** say it in chat — *"/delegate add pagination to the users list, use opencode/&lt;model&gt;"* — and Cursor passes `--model`.
- **Find model IDs:** `opencode models` in a terminal, or `/models`. Models are always `provider/model`
  (OpenCode Zen models are listed under the `opencode` provider; check the exact provider IDs for Zen / Go
  with `opencode models` since they can change).
- **Fixed default:** edit `env` in `mcp.json`:
  ```json
  "env": { "OPENCODE_DELEGATE_CWD": "${workspaceFolder}", "OPENCODE_DEFAULT_MODEL": "opencode/<model-id>" }
  ```

### 4. Tuning the delegation behavior
Edit `.cursor/rules/opencode-delegate.mdc`:
- `DELEGATION_MODE: auto | confirm | off`
- `DEFAULT_MODEL: default | provider/model`
- Change the LITE/HEAVY lists to match your team's definition of "simple".

## Tool reference

**`opencode_delegate`**

| Param | Description |
|---|---|
| `task` *(required)* | Self-contained instruction |
| `context`, `acceptance_criteria` | Plan excerpt / "done" checklist (OpenCode can't see the Cursor chat) |
| `model` | `provider/model`, optional |
| `agent`, `variant` | OpenCode agent / reasoning variant, optional |
| `files` | Files to attach (`--file`) |
| `session`, `continue_last` | Continue an OpenCode session for follow-up fixes |
| `cwd` | Sub-directory inside the workspace |
| `timeout_seconds` | 10–3600, default 900 |

Returns OpenCode's output + `git status` / `git diff --stat`.

**`opencode_models`** — `provider`, `filter`, `refresh` (runs `opencode models`).
**`opencode_doctor`** — checks the binary, versions, config.

### Environment variables

| Var | Default | Meaning |
|---|---|---|
| `OPENCODE_BIN` | `opencode` | Path to the binary (use if not on Cursor's PATH) |
| `OPENCODE_DELEGATE_CWD` | `${workspaceFolder}` | Project root |
| `OPENCODE_DEFAULT_MODEL` | – | Default `provider/model` |
| `OPENCODE_DEFAULT_AGENT` | – | Default agent |
| `OPENCODE_TIMEOUT_SECONDS` | 900 | Per-task timeout |
| `OPENCODE_MAX_OUTPUT_CHARS` | 20000 | Output size cap |

## Troubleshooting

| Problem | Fix |
|---|---|
| Red dot / server won't start | Run `cursor-opencode-delegate doctor`, then `cursor-opencode-delegate serve` in a terminal (should print "ready" on stderr). In `global` mode make sure the command is on the PATH Cursor sees; otherwise re-run `init --mode local` |
| `Could not find the "opencode" binary` | Cursor's PATH differs from your shell. Set `"OPENCODE_BIN": "/full/path/to/opencode"` in `env` (`which opencode` / `where opencode`) |
| "No models found" | Run `opencode auth login` in a terminal |
| Tool call times out in Cursor | Keep delegated tasks small, or lower `timeout_seconds`. The server sends progress heartbeats every 15s |
| Cursor never delegates | Check the rule is enabled (Settings → Rules) and `DELEGATION_MODE` isn't `off`; or use `/delegate` |
| OpenCode asks for permission and stalls | Configure permissions in your `opencode.json` (e.g. allow edits/bash for the `build` agent) so non-interactive `opencode run` doesn't need prompts |
| Wrong files touched | Use `acceptance_criteria` + exact paths in the task; review the diff; `git restore` to undo |

## Safety notes

- OpenCode edits your working tree directly — commit or stash first so the diff is clean to review.
- Don't put secrets in task prompts.
- `cwd` is restricted to the workspace; model/agent names are validated; no shell is used on macOS/Linux.

## Test

```bash
npm test      # MCP smoke test (fake opencode binary) + CLI tests; no network needed
```

## Uninstall

```bash
cursor-opencode-delegate uninstall
npm rm -g cursor-opencode-delegate     # or: npm rm cursor-opencode-delegate
```
