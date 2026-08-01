# Sandbox contract — DeerFlow → Claude Code port

**Source commit:** `0950924`. DeerFlow paths are relative to
`backend/packages/harness/deerflow/` unless prefixed. Port paths are relative to
`ports/claude-code/`.

**Evidence base:** `docs/claude-code-port/notes/sandbox-config-models.md` §1,
`docs/claude-code-port/middleware-port-plan.md` §6, §11,
`docs/claude-code-port/traceability-matrix.md` §5.

This document is the filesystem-and-tools half of the port's contract. It states what
each DeerFlow sandbox tool becomes, where files live, and which behaviors deliberately do
not survive. The environment-secrecy half lives in `config/permissions-preset.md` and
`src/policy/env-scrub.ts`.

---

## 1. Tool mapping

DeerFlow's sandbox tools (`sandbox/tools.py`) are all replaced by native Claude Code
tools. No shim, no wrapper — the port binds no tool of its own for file or shell work.

| DeerFlow tool | Claude Code tool | Fidelity | Notes |
|---|---|---|---|
| `bash` | `Bash` | approx | See §4.1. Path rewriting, secret-value masking, and the 20k middle-truncation are DeerFlow-side policy; the port re-applies the secrecy part through a PreToolUse hook and drops the rest. |
| `read_file` | `Read` | approx | 1-indexed `start_line`/`end_line` → `offset`/`limit`. DeerFlow's 50k head-truncation becomes Claude Code's own read limits. Widening: `Read` also handles images, PDFs, and notebooks, which DeerFlow split across `view_image` and dedicated conversion. |
| `write_file` | `Write` | approx | **`append=True` has no native equivalent.** See §4.2. DeerFlow's 80KB non-append cap is dropped (it mitigated a streaming timeout that does not exist here). |
| `str_replace` | `Edit` | approx (tightened) | DeerFlow replaces the first occurrence by default and takes `replace_all`. `Edit` *requires* the old string to be unique unless `replace_all` is set — a strictly stronger contract, and a documented improvement rather than a regression. |
| `ls` | `Glob` (or `Bash ls`) | approx | DeerFlow's 2-level tree rendering and its disabled-skill filtering are both dropped; the tree was presentation, and the port has no disabled-skill projection to hide. |
| `glob` | `Glob` | approx | Result caps differ (DeerFlow: 200 default / 1000 max). Native caps apply. |
| `grep` | `Grep` | approx | **Default case sensitivity flips**: DeerFlow defaults to case-*insensitive*, `Grep` follows ripgrep and defaults to case-*sensitive*. Callers that relied on the DeerFlow default must pass `-i`. |
| `view_image` | `Read` (image path) | obsolete | `Read` renders images natively. DeerFlow's 20MB cap, MIME sniff, and the deferred base64 injection through `ViewImageMiddleware` are all platform behavior here. |
| `present_files` | `outputs/` + final-message listing | approx | No tool. Replaced by the delivery contract in §3 — this is the one mapping row that becomes *prompt policy* rather than another tool. |

Corresponding traceability rows: `sandbox/tools.py` (7 rows) and
`tools/builtins/present_file_tool.py` in `traceability-matrix.md` §5.

---

## 2. Workspace and paths

**Workspace = the project working directory.** Claude Code runs `Bash`, `Read`, `Write`,
`Edit`, `Glob`, and `Grep` in the directory the session was started in, under the
platform's own permission rules, sandbox settings, and optional worktree isolation
(`-w/--worktree`). There is no sandbox to acquire, no container to warm, and no lease to
renew — `SandboxMiddleware` and the whole provider family
(`LocalSandboxProvider`, `AioSandboxProvider`, `E2BSandboxProvider`, `BoxliteProvider`,
`TenkiSandboxProvider`) are dropped as delivery infrastructure.

**Uploads = user-provided files.** DeerFlow's `/mnt/user-data/uploads` is a Gateway
feature: an HTTP endpoint stages files into a per-thread directory and
`UploadsMiddleware` announces them to the agent. Claude Code has no upload endpoint. In
the port, a user-provided file is simply a file the user references — by path, by drag,
or by paste — inside the working directory. The port never invents an `uploads/`
directory and never claims one exists.

**Outputs = `./outputs/`.** The one directory convention the port does keep. See §3.

### 2.1 Path mapping

| DeerFlow virtual path | Port equivalent |
|---|---|
| `/mnt/user-data/workspace` | the project working directory (`.`) |
| `/mnt/user-data/outputs` | `./outputs/` |
| `/mnt/user-data/uploads` | none — user-provided files are referenced in place |
| `/mnt/acp-workspace` | none — no ACP agent workspace in the port |
| `/mnt/skills/public` | `${CLAUDE_PLUGIN_ROOT}/skills/` (plugin-loaded) |
| `/mnt/skills/{custom,legacy,integrations}` | none — user skills are user-installed Claude Code skills |

Every `/mnt/...` occurrence in a ported skill body is rewritten accordingly; the
whitelist of permitted deviations lives in `src/prompts/substitutions.ts` and the
per-skill record in `docs/claude-code-port/skill-conversion-log.md`.

---

## 3. The `outputs/` delivery contract

DeerFlow's `present_files` tool (`tools/builtins/present_file_tool.py`) does two things:
it validates that a presented path lies under `/mnt/user-data/outputs`, and it appends
the path to the `artifacts` state channel, which the Gateway turns into a delivery
receipt. The run worker then *enforces* delivery: every regular file created or modified
under `outputs/` during a run must be covered by a path the journal attributes to
`present_files`, or the run is marked an error.

Claude Code has no artifacts channel and no delivery receipt. The port keeps the
user-facing half of that contract and states it as policy:

> **Files produced for the user land in `./outputs/`, and every file placed there MUST be
> listed in the final response.**

Three consequences worth stating plainly:

1. **`./outputs/` is for the user, not for the agent.** Intermediate files, scratch data,
   caches, and working copies belong in the working directory. Putting a scratch file in
   `outputs/` is a contract violation even though nothing rejects it.
2. **The listing is the delivery — and since M13 it is verified.** This was recorded at M5
   as a genuine weakening ("no receipt, no verification stage, and no run-level error for
   an unlisted file… the port relies on prompt policy"). **That gap is now closed.**
   `src/hooks/turn-snapshot.ts` captures a pre-turn workspace snapshot and
   `src/hooks/delivery-gate.ts` (a `Stop` hook) diffs against it: a turn that creates or
   modifies a file under `outputs/` without naming it in the final response is **blocked**
   with the ported `_DELIVERY_INCOMPLETE_ERROR` text plus the unpresented paths, and the
   verdict is written into `run-meta.json` as a put-if-absent delivery receipt carrying
   `produced_paths` / `presented_paths` / `matched_paths`. Two differences from the
   original survive and are declared in `parity/DISCREPANCIES.md` §M13: the check runs per
   **turn** rather than per **run**, and it blocks the turn rather than terminalizing the
   run as an error. What is enforced — "produced outputs must be presented" — is the
   original's invariant.
3. **The outputs-only path check disappears.** `present_files` raised
   `"Only files in /mnt/user-data/outputs can be presented"` for a path outside the
   directory. The port has no interception point, so nothing enforces the boundary.

---

## 4. Differences from `/mnt/user-data`, with reasons

### 4.1 Bash policy knobs

| DeerFlow behavior | Port | Reason |
|---|---|---|
| 600s wall-clock timeout, whole process group SIGKILLed (`sandbox.bash_command_timeout`) | Claude Code's own Bash timeout | Timeout enforcement belongs to whoever owns the spawn. |
| 20,000-char middle truncation of output (`sandbox.bash_output_max_chars`) | Claude Code's own output limits | Same reason. The DeerFlow value was tuned for its streaming contract. |
| `cd /mnt/user-data/workspace` prefix on every command | none | The working directory already is the workspace. |
| Container-path rewriting inside the command string, and host-path masking in the output | none | Neither direction has a path to translate. |
| `mask_secret_values` — injected secret values ≥8 chars replaced with `[redacted]` in output | PreToolUse deny on the way *in* (`src/hooks/env-guard.ts`) | The port cannot rewrite a tool result, so it refuses the command instead. Stricter and earlier, but it only sees values already in the environment. |
| `build_sandbox_env` — secret-looking names stripped from the inherited environment | deny rules + env-guard hook (`config/permissions-preset.md`) | The port cannot rewrite the child environment. This is the single largest fidelity loss in the sandbox port. |
| `DEERFLOW_CHANNEL_USER_ID` export prefix for IM runs | none | No IM channels in the port. |
| Request-scoped secret injection via `execute_command(env=...)` | none | No `required-secrets` binding path; skills that needed one must be re-declared against Claude Code's own configuration. |

### 4.2 `write_file(append=True)`

DeerFlow's `write_file` takes an `append` flag and exposes it in the model-facing schema.
`Write` overwrites only. Appending in the port means one of:

- `Read` the file, then `Write` the concatenation — safe, and the read-before-write
  discipline is the same one `ReadBeforeWriteMiddleware` enforced in DeerFlow;
- `Bash` with `>>` — cheaper, but outside the Read/Write tool path, so no read gate and
  no edit tracking.

The port states the trade rather than picking for the model. Neither reproduces DeerFlow's
atomic append.

### 4.3 Dropped entirely

- **Virtual path contract.** `PathMapping`, forward/reverse resolution, the
  "path escapes mounted directory" `PermissionError`, and the `_agent_written_paths`
  reverse-resolve hint (`sandbox/local/local_sandbox.py`) all exist to maintain the
  `/mnt/...` illusion. The port has no illusion to maintain.
- **Per-thread isolation.** DeerFlow gives every thread its own
  `{base_dir}/users/{user_id}/threads/{thread_id}/user-data/` tree. A Claude Code session
  works in the user's real project directory; there is no per-thread filesystem.
- **Skill projection.** The enabled-only hardlinked `skills_view/` trees
  (`skills/projection.py`) exist so a sandbox mount can show only enabled skills. Plugin
  skills are loaded by name; there is nothing to project.
- **Workspace-change capture.** The pre/post-run snapshot and diff
  (`workspace_changes/`) fed the Gateway's change-review API. No such API here.
  Note that its *sensitive-path pattern list* did survive — as the deny rules in
  `config/permissions-preset.json`.
- **`download_file` / `update_file`.** Gateway artifact-serving primitives with no
  model-facing counterpart.

---

## 5. What this contract does not cover

- Command *risk* classification (`SandboxAuditMiddleware`'s block/warn patterns) — M7,
  `middleware-port-plan.md` §11.
- Tool-output budgeting and externalization (`ToolOutputBudgetMiddleware`) — planned,
  `middleware-port-plan.md` §2.
- Guardrail / authorization tool gating — M7.
- The `required-secrets` request-scoped secret path — no port target chosen yet
  (`traceability-matrix.md` §6).
