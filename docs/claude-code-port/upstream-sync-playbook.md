# Upstream synchronization playbook (M16)

How to absorb upstream DeerFlow changes into the Claude Code port without drifting from the "faithful port" contract. Pinned base: `0950924`. Port location: `ports/claude-code/`.

## The procedure

1. `git fetch upstream main`.
2. Engine-relevant diff: `git log --oneline <pinned>..upstream/main -- backend/packages/harness skills contracts`. Frontend/gateway/deploy commits are out of scope by the engine boundary (`engine-boundary.md`).
3. For each engine commit, classify via the traceability matrix (`traceability-matrix.md` — find the touched file's row):
   - **Row = reuse-verbatim asset** (skills, prompt YAMLs, contract JSON, subagent prompts): re-copy the file, re-run the drift tests (`npm run parity`), update sha256 attributions.
   - **Row = translated code** (state, middleware, deep-run, prompts): read the upstream diff, apply the equivalent change to the TS twin, add/extend the vector test (if upstream changed test expectations, re-run the baseline extractor for that group against the NEW upstream commit and diff the vectors — vector changes are the signal that behavior moved).
   - **Row = replaced-by-native / excluded**: record "no port action" with one line of reasoning.
   - **No row**: add the row first (the M6 lane's step_events precedent), then classify.
4. After applying: `npm run check` + `npm run parity` green; update DISCREPANCIES if a deviation changed class; bump the pinned commit in ATTRIBUTION.md + plugin.json description; one commit per sync batch.
5. Never rewrite upstream history in the fork; sync commits merge upstream into the branch (`git merge upstream/main`) so the original files and the port evolve together.

## Dry run — executed 2026-08-01 against real upstream movement

`upstream/main` = `540940ba` (4 engine-relevant commits since the pin):

| Upstream commit | Touches | Matrix classification | Port action |
|---|---|---|---|
| `540940ba` feat(authz): model authorization at Gateway routes + runtime | authz/* + gateway | authz rows = collapsed (M12, intentionally omitted RBAC identity — single-user CLI); gateway = excluded delivery | **No port action**; noted in M12 rationale |
| `e221bddb` feat: per-server MCP tool name prefixes | `mcp/tools.py` + gateway router | MCP subsystem rows = replaced with native Claude Code MCP (`mcp__server__tool` naming is platform-owned and already per-server-prefixed) | **No port action** — the platform provides the equivalent natively |
| `459dd787` perf(frontend) | frontend only | excluded | **No port action** |
| `b295736e` fix(sandbox): judge command substitution by position in audit middleware | `agents/middlewares/sandbox_audit_middleware.py` (+273-line test) | SandboxAudit maps to the pre-tool-guard family; the port's env-guard/permission preset has a **declared open gap** on command-substitution obfuscation (`permissions-preset.md` "Known gaps", M5) — this upstream fix is directly relevant evidence for closing it | **Backlog item recorded**: port the position-based command-substitution judgment into env-guard at the next hardening pass; until then the gap remains declared, unchanged in class |

Conclusion of the dry run: the classification procedure resolves all four real commits without ambiguity; one produced a concrete backlog item, three produced documented no-ops. The playbook is exercised, not theoretical.

## Cadence recommendation

Sync monthly or before any release; always re-run `npm run parity` (vector suite) and the adversarial gate (`parity/fixtures/adversarial/`) after a sync that touched translated code.
