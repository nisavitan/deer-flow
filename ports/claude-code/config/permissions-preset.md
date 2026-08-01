# `permissions-preset.json` — recommended deny rules

A **recommended settings block**, not an automatically applied one. Nothing in the plugin
reads this file: Claude Code loads permissions from the user's own settings. Merge the
`permissions.deny` array into `~/.claude/settings.json` (all projects) or
`.claude/settings.json` (one project) to adopt it.

`allow` and `ask` are deliberately absent. The port has no opinion on what a user should
be allowed to do; it only asserts what should never happen. Adding an empty `allow` array
would suggest otherwise.

## Why these rules exist

DeerFlow protects secrets in two places the Claude Code port cannot reproduce directly:

1. **Env scrub** — `sandbox/env_policy.py:build_sandbox_env` strips every secret-looking
   variable (`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASS*`, `*CREDENTIAL*`, `*DSN*`, plus a
   19-name connection-string denylist) from the environment a sandbox subprocess inherits.
   Claude Code owns the Bash spawn, so the port cannot rewrite the child environment.
2. **Output masking** — `sandbox/tools.py:mask_secret_values` redacts injected secret
   values out of bash output before it re-enters the model context. The port has no write
   access to the tool result at that point.

The port replaces both with a three-layer split, of which this file is one layer:

| Layer | Mechanism | Covers |
|---|---|---|
| Deny rules (this file) | Claude Code permission system | reading credential files at all |
| `dist/hooks/env-guard.js` | PreToolUse hook on `Bash` | a command that embeds or re-exports a secret-like variable's value (`src/policy/env-scrub.ts`) |
| Prompt/skill guidance | `src/prompts/lead.ts` | the model's own handling of credentials |

Parity scenario **S24 — Secret-file protection (env scrub + deny rules)**
(`docs/claude-code-port/parity-test-plan.md`) is the acceptance test for the combination.
Its allowed-difference note is exactly this trade: reads of `.env` are *blocked* in the
port whereas DeerFlow *masks values* — stricter is acceptable; its zero-tolerance
assertion is that no canary value appears in any channel.

## Rule-by-rule origin

| Rule(s) | DeerFlow origin |
|---|---|
| `Read(./.env)`, `Read(./.env.*)`, `Read(./**/.env)`, `Read(./**/.env.*)` | `workspace_changes/scanner.py` sensitive-path fnmatch patterns `.env`, `.env.*` — files DeerFlow refuses to hash or read text from. S24's fixture `.env` carries the first canary. |
| `Read(./secrets/**)` | S24 fixture `secrets/token.json` (second canary); same scanner patterns (`*secret*`). |
| `Read(./**/*.pem)`, `Read(./**/id_rsa*)`, `Read(~/.ssh/id_*)` | scanner patterns `*.key`, `*.pem`, `*private_key*`. Private keys are the one credential class with no masking story at all — the value *is* the file. |
| `Read(~/.aws/credentials)` | Cloud provider credential file; matches the scanner's `*credential*` pattern. Outside the project tree, so no workspace-scoped rule reaches it. |
| `Read(~/.claude/.credentials.json)` | Claude Code's own OAuth credential store. No DeerFlow analog (DeerFlow's platform keys live in `os.environ`, which `build_sandbox_env` scrubs); this is the port-specific equivalent of that scrub target. |
| `Bash(cat .env*)` and the `head`/`tail`/`less`/`more`/`strings` siblings | `Read` deny rules do not cover a shell read. DeerFlow closed the same gap by scrubbing the subprocess environment rather than the command; the port must name the readers explicitly. |
| `Bash(cat ~/.aws/credentials)`, `Bash(cat ~/.claude/.credentials.json)`, `Bash(cat ~/.ssh/id_*)` | Same gap, for the out-of-tree files above. |
| `Bash(env)`, `Bash(printenv)`, `Bash(printenv *)` | The closest available stand-in for `build_sandbox_env`. The port cannot scrub the inherited environment, so it blocks the commands that dump it wholesale. Reading one named variable still reaches the env-guard hook, which denies when the value would land in the command string. |

## Known gaps (stated, not fixed here)

- Pattern-based `Bash(...)` rules match the command as written. `cat "$(echo .env)"`,
  `cat .en''v`, and `python -c "print(open('.env').read())"` are not covered by any deny
  rule; the env-guard hook does not cover them either, because it inspects values, not
  file paths. DeerFlow had the same class of gap and answered it with the sandbox
  boundary, which the port does not have.
- The env-guard hook is fail-open by design (see the header comment in
  `src/hooks/env-guard.ts`). These deny rules are enforced by the platform and are not,
  so they remain the harder of the two layers.
- Hardening beyond this preset — the full sandbox-audit classifier and the
  guardrail/authorization layers — is M7 work
  (`docs/claude-code-port/middleware-port-plan.md` §9, §11).

## M12 — sandbox settings guidance (finalized)

For stronger isolation than permission rules alone, users can enable Claude Code's native sandbox in project settings (`sandbox` key in settings.json — bash/filesystem isolation). Recommended pairing with this preset:

- Keep the preset's deny rules as the inner layer (they survive even with sandbox off).
- Enable OS-level sandboxing for Bash where available; the port's hooks (env-guard, loop-guard, write-gate) are enforcement layers independent of both.
- The DeerFlow analogy: LocalSandboxProvider's per-thread isolation maps to (project cwd + permission rules + optional native sandbox); AIO/E2B remote isolation has no port equivalent by design (excluded delivery infrastructure).

Authorization layers of the original (authz/: two-layer RBAC with assembly-time capability filtering + execution-time guardrail adapter) are **intentionally collapsed** for the single-user CLI context: layer-1 capability filtering → permission allow/deny rules + per-agent `tools:` frontmatter; layer-2 execution deny → PreToolUse hooks (env-guard + any user guard). Multi-user identity, roles, and fail-closed provider resolution have no meaning without a server boundary. Declared in the traceability matrix (authz rows) and DISCREPANCIES.
