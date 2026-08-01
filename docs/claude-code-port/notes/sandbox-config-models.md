# DeerFlow source analysis: Sandbox, Workspace Changes, Uploads, Authz, MCP, Models, Config

Source commit: 0950924. All paths relative to repo root. `harness` = `backend/packages/harness/deerflow`.

---

## 1. Sandbox abstraction

### 1.1 `Sandbox` interface (abstract)

`Sandbox` is an ABC with an `id` and eight abstract methods [Verified from source: backend/packages/harness/deerflow/sandbox/sandbox.py:44-182]:

| Method | Signature / semantics |
|---|---|
| `execute_command(command, env=None, timeout=None) -> str` | Runs a bash command; `env` carries per-call request-scoped secrets (never placed in the prompt/command string); `timeout` is a per-call wall-clock bound (remote impls may ignore it). Returns combined stdout/stderr text. [sandbox.py:56-91] |
| `read_file(path, start_line=None, end_line=None) -> str` | 1-indexed inclusive line slicing. [sandbox.py:93-110] |
| `download_file(path) -> bytes` | Raw bytes; must raise `PermissionError` on traversal / outside the allowed virtual prefix and `OSError` on read failure (single exception type across impls). [sandbox.py:112-129] |
| `list_dir(path, max_depth=2) -> list[str]` | Directory listing, default depth 2. [sandbox.py:131-142] |
| `write_file(path, content, append=False) -> None` | Create/overwrite or append text. [sandbox.py:144-153] |
| `glob(path, pattern, *, include_dirs=False, max_results=200) -> (list[str], truncated)` | [sandbox.py:155-158] |
| `grep(path, pattern, *, glob=None, literal=False, case_sensitive=False, max_results=100) -> (list[GrepMatch], truncated)` | Works on one text file or a directory tree. [sandbox.py:160-172] |
| `update_file(path, content: bytes) -> None` | Binary overwrite (used by artifact PUT and upload sync). [sandbox.py:174-182] |

`env` keys are validated against the POSIX env-var name rule `^[A-Za-z_][A-Za-z0-9_]*$` by `_validate_extra_env()` at the abstract layer — defense-in-depth for shell-splicing implementations (the AIO sandbox splices `export k=v`; local passes the dict to `subprocess.run(env=...)`) [Verified from source: backend/packages/harness/deerflow/sandbox/sandbox.py:6-41, 466-479 of local_sandbox.py].

### 1.2 `SandboxProvider` (abstract) + singleton

`SandboxProvider` declares `acquire(thread_id=None, *, user_id=None) -> str`, `acquire_async` (delegates via `asyncio.to_thread`), `get(sandbox_id) -> Sandbox | None`, `release(sandbox_id)`, and an optional `reset()`; class attrs `uses_thread_data_mounts = False` and `needs_upload_permission_adjustment = True` [Verified from source: backend/packages/harness/deerflow/sandbox/sandbox_provider.py:10-58]. A module-level singleton is created via `resolve_class(config.sandbox.use, SandboxProvider)` under a `threading.Lock` that guards only the reference swap (plugin constructors/`reset()`/`shutdown()` run outside the lock; a lost install race shuts down the orphan instance) [Verified from source: sandbox_provider.py:61-115]. `reset_sandbox_provider()` / `shutdown_sandbox_provider()` / `set_sandbox_provider()` manage lifecycle [sandbox_provider.py:118-175].

### 1.3 `LocalSandbox` implementation

**Path mappings.** `PathMapping(container_path, local_path, read_only=False)` (frozen dataclass); a sandbox holds a list of them fixed at construction [Verified from source: backend/packages/harness/deerflow/sandbox/local/local_sandbox.py:68-194]. Resolution machinery (all `cached_property`, since mappings never mutate):

- Forward resolution (`_resolve_path_with_mapping`): most-specific `container_path` first; the resolved path must stay under the mapping's resolved local root or `PermissionError` (EACCES, "path escapes mounted directory") is raised [local_sandbox.py:247-323].
- Reverse resolution (`_reverse_resolve_path`): longest local path first, `os.sep`-aware (Windows fix), rewrites host paths back to `/mnt/...` virtual form [local_sandbox.py:331-365].
- Command/content rewriting: `_command_pattern` (shell-aware boundary chars) rewrites container paths inside bash commands before execution; `_content_pattern` (text boundaries) rewrites container paths inside file content on `write_file`; `_reverse_output_patterns` (built by the shared `build_output_mask_pattern` in `path_patterns.py`) mask host paths back to virtual paths in command output [local_sandbox.py:201-239, 390-438; backend/packages/harness/deerflow/sandbox/path_patterns.py:39-68].
- `read_file` reverse-resolves paths **only** for files previously written via `write_file` (tracked in `_agent_written_paths`); user uploads / external content are never rewritten [local_sandbox.py:192-194, 704-710].

**Command execution.** `execute_command` validates env keys, rewrites container paths, detects a shell (`/bin/zsh` → `/bin/bash` → `/bin/sh` → `sh` on PATH; Windows falls back to pwsh/powershell/cmd.exe with MSYS handling), defaults `timeout` to `DEFAULT_COMMAND_TIMEOUT_SECONDS = 600` (overridable per call and via `sandbox.bash_command_timeout`), and builds the environment via `build_sandbox_env(env)` so an explicit scrubbed env is always passed [Verified from source: local_sandbox.py:24-29, 440-535]. On POSIX it uses `Popen` with `stdin=/dev/null`, `start_new_session=True` (own process group), and daemon pipe-drain threads with a bounded in-memory capture (`_COMMAND_CAPTURE_LIMIT_BYTES = 10 MiB`, truncation notice appended) so backgrounded processes (`server &`) return immediately; on timeout the whole process group is SIGKILLed and a notice tells the agent to background long-lived processes [local_sandbox.py:30-31, 34-65, 130-136, 537-637]. Output format: stdout, then `\nStd Error:\n...`, then timeout notice or `Exit Code: N` for non-zero exit, `"(no output)"` fallback, then reverse path masking [local_sandbox.py:524-535].

**Other operations.** `download_file` refuses any path not under `VIRTUAL_PATH_PREFIX = /mnt/user-data` and caps size at 100 MiB [local_sandbox.py:715-735; backend/packages/harness/deerflow/config/paths.py:12]. `write_file`/`update_file` raise `EROFS` for read-only mounts and create parent dirs [local_sandbox.py:737-758, 793-806]. `list_dir` overlays "virtual child" mount entries (e.g. `/mnt/skills/public`) that the plain filesystem walk would skip because their targets lie outside the listed root [local_sandbox.py:639-679]. OSErrors are re-raised with the original virtual path so host paths never leak in error messages [local_sandbox.py:711-713].

### 1.4 `LocalSandboxProvider`

- `acquire(thread_id, user_id=...)` returns a per-thread `LocalSandbox` with id **`local:{user_id}:{thread_id}`**; `acquire()`/`acquire(None)` returns the legacy generic singleton id `"local"` [Verified from source: backend/packages/harness/deerflow/sandbox/local/local_sandbox_provider.py:34-49, 266-277, 361-426].
- Static mappings (shared by all threads): the enabled-only **public skills projection** mounted read-only at `{skills.container_path}/public`, plus custom `sandbox.mounts` from config.yaml (absolute paths only; mounts colliding with reserved prefixes `{skills}/public|custom|integrations|legacy`, `/mnt/acp-workspace`, `/mnt/user-data` are rejected; missing host paths log ERROR with Docker guidance) [local_sandbox_provider.py:82-207].
- Per-thread mappings built at acquire time (after `paths.ensure_thread_dirs`): aggregate `/mnt/user-data` → `{thread}/user-data`, plus `/mnt/user-data/{workspace,uploads,outputs}`, `/mnt/acp-workspace`, and per-user read-only skill-view mounts `{skills}/custom|legacy|integrations` pointing at enabled-only projection roots [local_sandbox_provider.py:279-359].
- Skill projection is re-checked on **every** acquire (self-heals drift; ~3-4 ms fresh, full rebuild under a cross-process lock when stale); projection failure never fails acquire (skill mounts are skipped) [local_sandbox_provider.py:215-242, 386-393].
- **Per-thread LRU**: `_thread_sandboxes: OrderedDict[(user_id, thread_id) -> LocalSandbox]` capped at `DEFAULT_MAX_CACHED_THREAD_SANDBOXES = 256`, guarded by a provider-wide `threading.Lock`; `get()` promotes entries; eviction only costs the `_agent_written_paths` reverse-resolve hint [local_sandbox_provider.py:23-31, 56-80, 428-463]. `release()` is deliberately a no-op so the sandbox (and its written-path set) survives across turns; `reset()`/`shutdown()` clear everything [local_sandbox_provider.py:465-494].

### 1.5 Physical layout / path mapping table

`Paths.base_dir` = constructor arg → `$DEER_FLOW_HOME` → `{project_root}/.deer-flow` (project root = `$DEER_FLOW_PROJECT_ROOT` or CWD) [Verified from source: backend/packages/harness/deerflow/config/paths.py:122-161; backend/packages/harness/deerflow/config/runtime_paths.py:7-24]. When the gateway runs from `backend/`, this is `backend/.deer-flow/`.

| Virtual (agent-visible) | Physical (host) |
|---|---|
| `/mnt/user-data/workspace` | `{base_dir}/users/{user_id}/threads/{thread_id}/user-data/workspace` |
| `/mnt/user-data/uploads` | `.../user-data/uploads` |
| `/mnt/user-data/outputs` | `.../user-data/outputs` |
| `/mnt/acp-workspace` | `{base_dir}/users/{user_id}/threads/{thread_id}/acp-workspace` |
| `/mnt/skills/public` | `{base_dir}/skills_view/public` (enabled-only projection of `deer-flow/skills/public`) |
| `/mnt/skills/{custom,legacy,integrations}` | `{base_dir}/users/{user_id}/skills_view/{custom,legacy,integrations}` |

[Verified from source: paths.py:102-127, 259-346; local_sandbox_provider.py:296-355]. Legacy no-user layout `{base_dir}/threads/{thread_id}/...` still exists when `user_id is None` [paths.py:285-303]. `ensure_thread_dirs` creates workspace/uploads/outputs/acp-workspace with chmod 0o777 (container UID mismatch) [paths.py:390-410]. `resolve_virtual_path()` maps `/mnt/user-data/...` → host with segment-boundary prefix check and traversal rejection [paths.py:421-455]. Thread ids match `^[A-Za-z0-9_-]{1,64}$`; user ids match `[A-Za-z0-9_-]+`, with `make_safe_user_id()` sanitizing external IM ids via SHA-256-suffixed digests [paths.py:14-71].

### 1.6 Env scrubbing policy (`env_policy.py`)

`build_sandbox_env(injected)` = `os.environ` minus secret-looking names, then injected request-scoped secrets layered on top (**injected wins even if the name matches a blocked pattern**) [Verified from source: backend/packages/harness/deerflow/sandbox/env_policy.py:100-112]. Blocked:

- Wildcard patterns (case-insensitive on upper-cased name): `*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASS*` (also catches `*_ASKPASS` helpers, `PGPASSFILE`), `*CREDENTIAL*`, `*DSN*` [env_policy.py:24-46].
- Exact-name denylist for connection strings / no-flag credential sources: `DATABASE_URL`, `DATABASE_URI`, `REDIS_URL`, `MONGODB_URI`, `MONGO_URL`, `AMQP_URL`, `RABBITMQ_URL`, `POSTGRES_URL`, `POSTGRESQL_URL`, `MYSQL_URL`, `CLICKHOUSE_URL`, `CONNECTION_STRING`, `CONN_STR`, `GH_PAT`, `GITHUB_PAT`, `MYSQL_PWD`, `REDISCLI_AUTH`, `REDIS_AUTH`, `PGSERVICEFILE` [env_policy.py:66-88].

Benign vars (`PATH`, `HOME`, `LANG`, `PWD`, `TMPDIR`, `VIRTUAL_ENV`, `PYTHONPATH`, ...) survive because they contain none of the tokens [env_policy.py:20-23].

### 1.7 Supporting modules

- **`security.py`**: host bash is a gated capability — `is_host_bash_allowed()` returns False for `LocalSandboxProvider` unless `sandbox.allow_host_bash: true`; canned messages explain the local provider is not a secure boundary [Verified from source: backend/packages/harness/deerflow/sandbox/security.py:1-45].
- **`file_operation_lock.py`**: per-`(sandbox_id, path)` `threading.Lock` held in a `WeakValueDictionary` (used to serialize `str_replace`/write races per path without leaking locks) [Verified from source: backend/packages/harness/deerflow/sandbox/file_operation_lock.py:1-27].
- **`overwrite.py`**: `unwrap_sandbox()` unwraps a `langgraph.types.Overwrite`-wrapped sandbox channel value from fork-restored delta checkpoints; the wrapped form means "not owned by this run — do not release" [Verified from source: backend/packages/harness/deerflow/sandbox/overwrite.py:1-21].
- **`search.py`**: shared glob/grep engine. `IGNORE_PATTERNS` (~55 entries: `.git`, `node_modules`, `__pycache__`, `.venv`, `dist`, `*.log`, `.upload-*.part`, caches, IDE dirs, ...) precompiled into an exact-name set + one combined regex; grep skips symlinks, files > 1,000,000 bytes, binary files (NUL in first 8 KiB), and lines > 2000 chars (ReDoS guard), truncating matched lines to 200 chars [Verified from source: backend/packages/harness/deerflow/sandbox/search.py:7-226].
- **`exceptions.py`**: `SandboxError` base with structured `details`; subclasses `SandboxNotFoundError`, `SandboxRuntimeError`, `SandboxCommandError`, `SandboxFileError` (+ `SandboxPermissionError`, `SandboxFileNotFoundError`), and `SandboxCapacityExceededError` (code `SANDBOX_CAPACITY_EXCEEDED`, retryable with `retry_after_seconds`) [Verified from source: backend/packages/harness/deerflow/sandbox/exceptions.py:1-114].

### 1.8 Community/remote provider families (one paragraph each; not read in depth)

- **AioSandboxProvider** (`harness/community/aio_sandbox/`): Docker (or Apple Container / provisioner-managed K8s Pod) "all-in-one-sandbox" containers with the user-data dirs volume-mounted at the same `/mnt/user-data` virtual paths; per-call secrets go through the container's `bash.exec(env=...)` HTTP API (image ≥ 1.9.3 required); warm pool + idle reaper via a shared `WarmPoolLifecycleMixin` (defaults idle 600 s, check 60 s, replicas 3), and a cross-instance ownership lease store (`memory`/`redis`) so multiple gateways sharing one backend cannot adopt/destroy each other's containers [Verified from source: backend/AGENTS.md "Sandbox System" section; config.example.yaml:1244-1347; backend/packages/harness/deerflow/config/sandbox_config.py:9-46].
- **E2BSandboxProvider** (`harness/community/e2b_sandbox/`): remote E2B micro-VMs; skills are one-shot uploaded at creation (no shared host mount); capacity policies `wait`/`reject`/`burst` with `acquire_timeout`/`burst_limit`, Redis-shared deployment-wide capacity, release-time output sync bounded by aggregate byte/file/deadline ceilings [Verified from source: backend/AGENTS.md "Sandbox System"; sandbox_config.py:116-134].
- **BoxliteProvider** (`harness/community/boxlite/`): local BoxLite micro-VMs (KVM / Hypervisor.framework); loop-affine handles owned by one private asyncio loop on a daemon thread; deterministic box names from `user_id:thread_id`, in-process warm pool, `replicas` caps active+warm per process [Verified from source: backend/AGENTS.md "Sandbox System"; config.example.yaml:1349-1376].
- **TenkiSandboxProvider** (`harness/community/tenki/`): Tenki cloud micro-VMs via a synchronous SDK; native `sandbox.fs` file transport, `/mnt/user-data` remapped under a writable HOME with best-effort sudo symlinks, warm pool keyed by `sha256(user_id:thread_id)[:16]` [Verified from source: backend/AGENTS.md "Sandbox System"; config.example.yaml:1392-1411].

---

## 2. Workspace changes (pre/post-run diff)

**Data model** [Verified from source: backend/packages/harness/deerflow/workspace_changes/types.py:14-117]: `WorkspaceRoot(name, host_path, virtual_prefix)`; `FileSnapshot(path, root, size, mtime_ns, sha256, binary, sensitive, text/text_path, content_unavailable_reason, symlink, symlink_target)`; `WorkspaceSnapshot(files, truncated, text_cache_dir)`; per-file `WorkspaceFileChange` with status `created|modified|deleted|symlink_created`, before/after size + sha256, unified `diff`, `additions`/`deletions`, `diff_unavailable_reason ∈ {binary, large, sensitive, truncated, symlink}`.

**Limits** (`WorkspaceChangeLimits`, defaults): `max_files=200` reported changes, `max_scanned_files=2000`, `max_file_bytes_for_diff=256 KiB` (per file; above it no sha256/text → reason "large"), `max_total_diff_bytes=1 MiB` (aggregate diff budget) [Verified from source: types.py:18-27].

**Scanner** [Verified from source: backend/packages/harness/deerflow/workspace_changes/scanner.py:19-330]: walks the roots (`followlinks=False`), pruning `EXCLUDED_DIR_NAMES` (`.git`, `.hg`, `.svn`, `.cache`, `.next`, `.venv`, browser-frames dir, `__pycache__`, `build`, `dist`, `node_modules`) and symlinked dirs. Sensitive paths — matched by fnmatch patterns `.env`, `.env.*`, `*api_key*`, `*apikey*`, `*.key`, `*.pem`, `*credential*`, `*password*`, `*private_key*`, `*secret*`, `*token*` against basename, full path, and each segment — become metadata-only stubs (no hash, no text). Symlinks are recorded as metadata-only stubs via `lstat` + `readlink` (never followed). Binary detection = extension set (~30 extensions) or NUL/undecodable 4 KiB sample; UTF-8/UTF-8-BOM/UTF-16-BOM text is decoded; text can be spilled to a cache dir (sha256-of-path filenames) instead of memory.

**Diff** [Verified from source: backend/packages/harness/deerflow/workspace_changes/diff.py:17-221]: `_same_file` compares sha256 when both present, else `(size, mtime_ns)`. A symlink appearing at a previously non-symlink path is always `symlink_created`. Diffs are `difflib.unified_diff`; a diff exceeding the remaining aggregate byte budget is dropped with reason `truncated` (line counts kept). `get_changed_output_paths()` returns created/modified regular files under the `outputs` root (feeds the run delivery-receipt check).

**Recorder flow** [Verified from source: backend/packages/harness/deerflow/workspace_changes/recorder.py:26-167]: `build_thread_workspace_roots(thread_id, user_id)` covers only `workspace` and `outputs` (uploads intentionally excluded). `capture_workspace_snapshot()` (called pre-run by `runtime/runs/worker.py`) runs root resolution + `mkdtemp` + scan via `asyncio.to_thread`, with cancellation-safe reclaim of the temp text cache. `record_workspace_changes()` (post-run): metadata-only scan → `get_changed_paths(before, after_metadata)` → second scan reading text **only for changed paths** → `compare_snapshots` → if changes exist, one event `put(event_type=workspace_changes, category=workspace, content="N files changed +A -D", metadata={workspace_changes: payload})`; the before-snapshot's text cache is removed in `finally`. **API** `get_workspace_changes_response()` reads the last such event (limit 10) and can strip files/diffs per query flags [Verified from source: backend/packages/harness/deerflow/workspace_changes/api.py:18-77].

---

## 3. Uploads manager (`harness/uploads/manager.py`)

Pure, HTTP-free helpers shared by Gateway and the embedded client [Verified from source: backend/packages/harness/deerflow/uploads/manager.py:1-353]:

- Directory: `get_uploads_dir(thread_id, user_id)` → `paths.sandbox_uploads_dir(...)` (validates thread id; user defaults to effective user); `ensure_uploads_dir` mkdirs it [manager.py:33-43].
- Filenames: `normalize_filename` strips to basename, rejects empty/`.`/`..`, rejects backslashes, caps at 255 UTF-8 bytes; `claim_unique_filename` appends `_N` on collision within one request [manager.py:46-96].
- Staging: gateway writes go to `.upload-*.part` files (`UPLOAD_STAGING_PREFIX/SUFFIX`); these are hidden from listings and swept on startup by `cleanup_stale_upload_staging_files()` over both legacy and per-user layouts [manager.py:29-31, 99-163, 279-280].
- Safety: `validate_path_traversal` (resolve + `relative_to`); `validate_upload_destination` rejects non-regular files and hardlinked (`st_nlink > 1`) destinations; `open_upload_file_no_symlink` opens with `O_NOFOLLOW` (+ `fstat` regular-file/nlink==1 re-check, `ftruncate`) on POSIX, and a narrowed double-`lstat` + `fstat` TOCTOU mitigation on Windows — because a sandboxed process could plant a symlink at a future upload name and hijack a gateway-privilege write [manager.py:104-259].
- Listing/deletion: `list_files_in_dir` skips staging files and symlinks, returns filename/size/path/extension/mtime; `delete_file_safe` validates traversal and also removes a companion `.md` produced by document conversion [manager.py:262-327].
- URLs: `upload_virtual_path(f)` = `/mnt/user-data/uploads/{f}`; `upload_artifact_url` = `/api/threads/{tid}/artifacts/mnt/user-data/uploads/{quoted}` [manager.py:330-352].

---

## 4. Authz + guardrails (layer model, brief)

Two sibling systems share one enforcement middleware:

- **Guardrails** (`harness/guardrails/`) — execution-time-only tool-call gate. `GuardrailProvider` protocol: `evaluate(GuardrailRequest) -> GuardrailDecision` (+ async), where the request carries `tool_name`, `tool_input`, identity fields (`user_id`, `user_role`, `channel_user_id`, `is_internal`, `authz_attributes`), thread/run/tool_call ids [Verified from source: backend/packages/harness/deerflow/guardrails/provider.py:9-67]. Built-in `AllowlistProvider` distinguishes "no allowlist" (None → allow all) from an explicitly empty allowlist ([] → deny all), plus a denylist [Verified from source: backend/packages/harness/deerflow/guardrails/builtin.py:6-27]. Configured via `guardrails: {enabled: false, fail_closed: true, passport, provider: {use, config}}` [Verified from source: backend/packages/harness/deerflow/config/guardrails_config.py:6-24].
- **Authorization** (`harness/authz/`) — the RBAC "policy brain", enforced at **two layers from one policy**: (1) assembly-time capability filtering removes tools a role can never use before they are bound (so the model never sees them and `tool_search` cannot promote them back — fail-closed), and (2) run-time execution deny by reusing `GuardrailMiddleware` through `GuardrailAuthorizationAdapter` [Verified from source: backend/packages/harness/deerflow/authz/provider.py:1-21].
- `Principal` (user_id, role, oauth ids, channel_user_id, is_internal, attributes) is built only by `build_principal_from_context()` (pure; default_role fills only missing/empty roles; `authz_attributes` must be a Mapping) so Layer 1 and Layer 2 share identity semantics [Verified from source: backend/packages/harness/deerflow/authz/principal.py:16-62]. The adapter rebuilds the Principal per request, maps `GuardrailRequest → AuthzRequest(resource="tool", action="call", target=tool_name)`, lets provider exceptions propagate (the middleware owns fail-closed), and short-circuits allow for `infrastructure_tool_names` (e.g. a `tool_search` built from an already-filtered catalog) [Verified from source: backend/packages/harness/deerflow/authz/adapter.py:27-138].
- Built-in `RbacAuthorizationProvider`: `roles.{role}.{tools|models|skills|sandbox|mcp_servers|routes}: {allow: "*"|bool|[...], deny: [...]}` compiled at construction with strict validation (unknown keys/aliases/null rejected); deny wins; no policy for (role, resource) = unrestricted; unknown/missing role raises (execution layer's `fail_closed` decides) [Verified from source: backend/packages/harness/deerflow/authz/rbac.py:26-262].
- Layer-1 helpers: `filter_tools_by_authorization` (provider errors → `[]` when fail_closed, else original set) and the one-call wrapper `apply_tool_authorization` (resolves provider once, returns `(filtered_tools, provider)` for reuse by Layer 2) [Verified from source: backend/packages/harness/deerflow/authz/enforcement.py:15-42; backend/packages/harness/deerflow/authz/tool_filter.py:22-72]. Provider construction: `resolve_authorization_provider(config)` resolves the class path, validates the Protocol, and pre-validates `default_role` against RBAC roles [Verified from source: backend/packages/harness/deerflow/authz/runtime.py:15-58]. Config: `authorization: {enabled: false, fail_closed: true, default_role: "user", provider: {use, config}}` [Verified from source: backend/packages/harness/deerflow/config/authorization_config.py:14-32].

---

## 5. MCP integration

### 5.1 Client + transports

`build_server_params()` maps `McpServerConfig` → `MultiServerMCPClient` params: transport `stdio` (requires `command`; passes `args`, `env`), `sse`/`http` (require `url`; pass `headers`); anything else raises [Verified from source: backend/packages/harness/deerflow/mcp/client.py:11-68]. The MCP-spec `transport` field is accepted as an alias for `type` [Verified from source: backend/packages/harness/deerflow/config/extensions_config.py:19-25, 107-119].

### 5.2 Lazy cache + invalidation signature

`get_cached_mcp_tools()` lazily initializes (handles running/no event loop; a running loop spawns a thread running `asyncio.run`) and serves a module-level cache [Verified from source: backend/packages/harness/deerflow/mcp/cache.py:116-189]. Staleness = resolved extensions-config **path changed** OR **content signature `(mtime, size, sha256)` changed** vs. values recorded at init (`config/file_signature.py` helper shared with `app_config`), deliberately not a `mtime >` comparison (catches same-second edits, backward mtime, file swaps) [Verified from source: cache.py:18-113]. Fail-soft rules: unresolvable path during the staleness check (deleted explicit/env-var config mid-run) is treated as "unconfigured — not stale", so the cache keeps serving last-known-good tools [cache.py:31-64, 92-103]. `reset_mcp_tools_cache()` clears everything and closes/replaces the session pool (same-loop sessions are only *signalled*; foreign-loop sessions torn down deterministically) [cache.py:192-227].

### 5.3 Tool loading (`tools.py`)

`get_mcp_tools()` reads `ExtensionsConfig.from_file()` fresh (not the singleton), builds servers config, injects initial OAuth headers into sse/http headers, assembles tool interceptors (OAuth first, then `mcpInterceptors` builder paths from extensions config), and creates `MultiServerMCPClient(servers_config, tool_interceptors, tool_name_prefix=True)`; each server's tools load independently so one broken server doesn't block the rest [Verified from source: backend/packages/harness/deerflow/mcp/tools.py:572-663]. Then per tool:

- Names must match `^[A-Za-z0-9_-]+$` or the tool is dropped (hostile names could forge prompt structure for deferred tools) [tools.py:29-39, 681-688].
- Tools are tagged with MCP metadata and effective routing (`server.routing` merged with per-tool overrides; stored under `tool.metadata.deerflow_mcp_routing`) [tools.py:689-694; extensions_config.py:122-131].
- **Only stdio** tools are wrapped for session pooling (`_make_session_pool_tool`); HTTP/SSE tools stay unwrapped (anyio TaskGroups cannot be closed cross-task, #3203); routing is exact by source-server grouping, and `tool_call_timeout` applies only to stdio (warned otherwise) [tools.py:665-705].
- Every coroutine-only tool gets a sync `func` via `make_sync_tool_wrapper` for the embedded sync client [tools.py:707-711].

### 5.4 Stdio sessions: pooling, cwd/TMPDIR pinning

The stdio wrapper resolves `thread_id` (runtime context → config → LangGraph config → "default") and `user_id`, scoping the pooled session key as `f"{user_id}:{thread_id}"` (filesystem isolation is per user+thread) [Verified from source: tools.py:307-322, 453-463]. For stdio it runs `_prepare_stdio_workspace` off-loop: ensures thread dirs, sets the subprocess `cwd` default to the thread workspace (operator-configured `cwd` wins), pins `TMPDIR`/`TMP`/`TEMP` to `workspace/.mcp/tmp` (0700; `setdefault`, so operator env wins), and snapshots workspace files (path → (mtime_ns, size)) before the call [tools.py:41-46, 143-187, 464-495]. Calls go through the interceptor chain (headers forwarded via MCP call `meta` for stdio) with optional `read_timeout_seconds` from `tool_call_timeout` [tools.py:497-543].

`MCPSessionPool` [Verified from source: backend/packages/harness/deerflow/mcp/session_pool.py:12-461]: every session is owned by a dedicated `_run_session` task that enters/initializes the `create_session` context manager and waits on a close event, so `__aexit__` always runs in the entering task (anyio same-task cancel-scope rule; issue #3379). `MAX_SESSIONS = 256` with LRU eviction; sessions bound to a different/closed loop are evicted and rebuilt; concurrent same-loop creators join one in-flight creation; `close_scope`/`close_server`/`close_all`/`close_all_sync` route teardown to owning loops (`SESSION_CLOSE_TIMEOUT = 5 s`).

### 5.5 Result path translation

`_convert_call_tool_result` converts MCP content blocks to LangChain content-and-artifact format and translates local file references to virtual paths — **no copying**; since stdio servers already write inside the mounted tree, only the prefix mapping is needed [Verified from source: tools.py:325-425]. Three mechanisms, all bounded to files that actually exist inside the thread's user-data tree (`_local_uri_to_virtual_path` resolves against `sandbox_user_data_dir` and refuses anything outside): (1) `ResourceLink` URIs (bare paths and `file://`); (2) conservative free-text path regex rewriting (trailing punctuation preserved); (3) bare-filename correlation — a basename mentioned in result text is rewritten only when the before/after workspace snapshot diff shows exactly one changed file with that name (the after-scan runs only when the result has text content) [tools.py:48-58, 63-304, 545-560]. `isError` results raise `ToolException`; `structuredContent` becomes `artifact.structured_content` [tools.py:417-425].

### 5.6 OAuth (`oauth.py`)

`OAuthTokenManager` caches tokens per server with per-server `threading.Lock`s (not asyncio — callers arrive from many short-lived loops); refresh is triggered `refresh_skew_seconds` (default 60) before expiry; grants supported: `client_credentials` (requires client_id+secret) and `refresh_token` (rotated refresh tokens are kept **in-process only**, never written back to extensions_config.json); token/type/expiry field names and default token type are configurable; lock acquisition is a shielded task so cancellation can never leak a held lock [Verified from source: backend/packages/harness/deerflow/mcp/oauth.py:26-175]. `build_oauth_tool_interceptor` injects `Authorization` per call; `get_initial_oauth_headers` primes connection headers for discovery (failures skip the server's header, logged) [oauth.py:178-216].

### 5.7 Deferred tools + tool_search relation

When `tool_search.enabled` is true, MCP tool schemas are *not* bound to the model: they are listed by name in the system prompt, hidden by `DeferredToolFilterMiddleware`, and promoted per-thread by the `tool_search` tool or auto-promoted (up to `tool_search.auto_promote_top_k`, default 3, clamped 1..5) by `McpRoutingMiddleware` matching `routing.mode: "prefer"` keywords against the latest user message; promotions are hash-scoped to the tool catalog in `ThreadState.promoted` [Verified from source: backend/packages/harness/deerflow/config/tool_search_config.py:14-34; backend/AGENTS.md middleware chain items 24-25 and "MCP System"; config.example.yaml:1018-1032]. The load-boundary name canonicalization above exists precisely because deferred names bypass provider bind-time validation [tools.py:29-39].

---

## 6. Model factory + `claude_provider.py`

### 6.1 `create_chat_model` flow

`create_chat_model(name=None, thinking_enabled=False, *, app_config=None, attach_tracing=True, model_overrides=None, **kwargs)` [Verified from source: backend/packages/harness/deerflow/models/factory.py:174-321]:

1. `name=None` → first entry in `config.models`; unknown name → `ValueError`. Class resolved via `resolve_class(model_config.use, BaseChatModel)` [factory.py:202-208].
2. Constructor kwargs = `model_config.model_dump(exclude_none=True)` minus DeerFlow metadata fields (`use`, `name`, `display_name`, `description`, `supports_thinking`, `supports_reasoning_effort`, `when_thinking_enabled/disabled`, `thinking`, `supports_vision`, `context_window`, `pricing`) [factory.py:209-230].
3. `model_overrides` (per-agent temperature/max_tokens) layered on top, `None` values ignored, applied before thinking/Codex transforms [factory.py:231-238].
4. **Thinking**: effective settings = `when_thinking_enabled` merged with the `thinking` shortcut. If `thinking_enabled` and settings exist but `supports_thinking` is false → `ValueError`. When thinking is *off*: `when_thinking_disabled` wins if present; else the factory auto-derives a disable payload per provider style — OpenAI-compatible gateways (`extra_body.thinking.type` → `{"type": "disabled"}` + `reasoning_effort: "minimal"`), vLLM/Qwen (`extra_body.chat_template_kwargs.enable_thinking/thinking → False`), or native Anthropic (`thinking: {"type": "disabled"}`) [factory.py:239-270]. `reasoning_effort` is stripped unless `supports_reasoning_effort` [factory.py:271-273].
5. OpenAI-compat normalization: `api_base` → `base_url` alias fix for `BaseChatOpenAI` subclasses; default `stream_chunk_timeout = 240 s` injected for `BaseChatOpenAI` subclasses (dropped for others); Codex models drop `max_tokens` and map thinking → `reasoning_effort` (`none`/explicit/`medium`); MindIE forces `max_retries=1`; `stream_usage=True` defaulted so third-party endpoints report usage; unknown-key warning for OpenAI-family typos [factory.py:126-311].
6. Instantiate `model_class(**kwargs, **settings)`; when `attach_tracing` (default), Langfuse/LangSmith callbacks are appended to the model instance (graph-rooted callers must pass `attach_tracing=False` to avoid duplicate spans) [factory.py:313-321].

`supports_vision` is not consumed by the factory itself — it gates `view_image` tool binding and `ViewImageMiddleware` at agent assembly [Verified from source: backend/packages/harness/deerflow/config/model_config.py:34; backend/AGENTS.md "Tool System" item 3 and middleware 23].

### 6.2 `claude_provider.py` — EXACTLY what it does

`ClaudeChatModel` **subclasses `langchain_anthropic.ChatAnthropic`** and adds OAuth Bearer auth, prompt caching, auto thinking budget, and retry [Verified from source: backend/packages/harness/deerflow/models/claude_provider.py:44-63]. Custom fields: `enable_prompt_caching: bool = True`, `prompt_cache_size: int = 3`, `auto_thinking_budget: bool = True`, `retry_max_attempts: int = 3` [claude_provider.py:55-59].

**Auth resolution** (`model_post_init`) [claude_provider.py:69-126]:
- If the configured `anthropic_api_key` is empty or the placeholder `"your-anthropic-api-key"`, it calls `load_claude_code_credential()` which tries, in order: (1) `$CLAUDE_CODE_OAUTH_TOKEN` or `$ANTHROPIC_AUTH_TOKEN`; (2) a token read from the fd named by `$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`; (3) the JSON credentials file at `$CLAUDE_CODE_CREDENTIALS_PATH`; (4) `~/.claude/.credentials.json` — parsing the Claude Code CLI's `claudeAiOauth.{accessToken, refreshToken, expiresAt}` shape and rejecting expired tokens (1-minute buffer) with "Run 'claude' to refresh" [Verified from source: backend/packages/harness/deerflow/models/credential_loader.py:26-47, 108-196].
- **OAuth detection**: any key containing `sk-ant-oat` (`is_oauth_token`) flips the model into OAuth mode [credential_loader.py:29-31; claude_provider.py:98-111]. OAuth mode: adds `anthropic-beta: oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14` headers [credential_loader.py:26], patches the sync and async Anthropic SDK clients to `api_key=None, auth_token=<token>` (Authorization: Bearer) [claude_provider.py:124-132], **disables prompt caching** (OAuth's 4-cache-block limit) [claude_provider.py:109-110] and strips any `cache_control` markers from payloads in `_create`/`_acreate` [claude_provider.py:263-294].
- Non-OAuth keys behave as standard `x-api-key` ChatAnthropic.

**Request payload shaping** (`_get_request_payload` override) [claude_provider.py:134-153]:
- OAuth billing: injects a billing header text block (`x-anthropic-billing-header: cc_version=...; cc_entrypoint=cli; ...`, overridable via `$ANTHROPIC_BILLING_HEADER`) as the **first** system block, and a `metadata.user_id` JSON blob (`device_id` = sha256 of `deerflow-{hostname}`, `account_uuid: "deerflow"`, random `session_id`) required for OAuth billing validation — the format mirrors the Claude Code CLI [claude_provider.py:37-41, 155-190].
- Prompt caching (API-key mode): places `cache_control: {type: ephemeral}` on the **last 4** candidates among (system text blocks, content blocks of the last `prompt_cache_size` messages, the last tool definition) — 4 being the Anthropic/Bedrock breakpoint hard limit; assumes a fully static system prompt (dynamic context rides `DynamicContextMiddleware`'s `<system-reminder>` in the first HumanMessage) [claude_provider.py:192-248].
- Auto thinking budget: when `thinking.type == "enabled"` and no `budget_tokens`, sets `budget_tokens = int(max_tokens * 0.8)` (default `max_tokens` 8192) [claude_provider.py:35, 250-261].

**Retry**: `_generate`/`_agenerate` re-patch the OAuth client, then retry `anthropic.RateLimitError` and `anthropic.InternalServerError` up to `retry_max_attempts` with exponential backoff (2 s base doubling + 20% buffer), honoring `Retry-After` verbatim [claude_provider.py:296-363].

**Port-relevant takeaway**: DeerFlow already piggybacks on Claude Code's own OAuth credential store and billing conventions — the provider exists to make an Anthropic-shaped LangChain client behave like the Claude Code CLI. In a Claude Code port, the CLI/harness owns model calls natively, so this entire module (and `credential_loader`'s Claude half) becomes redundant rather than something to re-implement.

### 6.3 Other providers (one paragraph)

The remaining `models/` modules are provider-compat adapters: `openai_codex_provider.py` is a from-scratch `BaseChatModel` speaking the ChatGPT Codex Responses API at `https://chatgpt.com/backend-api/codex` using Codex CLI OAuth tokens auto-loaded from `~/.codex/auth.json` ($CODEX_AUTH_PATH override) [Verified from source: backend/packages/harness/deerflow/models/openai_codex_provider.py:1-29; credential_loader.py:198-220]; `vllm_provider.py` (`VllmChatModel`, ChatOpenAI subclass) preserves vLLM's non-standard `reasoning` field across streaming/tool-call turns and optionally converts cumulative stream usage to deltas [Verified from source: backend/packages/harness/deerflow/models/vllm_provider.py:1-14]; `mindie_provider.py` flattens tool messages into XML-ish text for MindIE chat templates with mock-streaming [Verified from source: backend/packages/harness/deerflow/models/mindie_provider.py:14-21]; `patched_deepseek/mimo/minimax/stepfun/openai.py` all replay provider-specific assistant fields (`reasoning_content`, MiniMax `reasoning_details`, Gemini `thought_signature`) onto historical assistant payloads via the shared `assistant_payload_replay.py` helper, because plain `ChatOpenAI` drops them and thinking-mode APIs 400 without them [Verified from source: backend/packages/harness/deerflow/models/patched_deepseek.py:1-16; patched_mimo.py:1-21; patched_minimax.py:1-27; patched_stepfun.py:1-24; patched_openai.py:1-31; assistant_payload_replay.py:1-31].

---

## 7. Complete config schema reference

Config file: repo-root `config.yaml` (copy of `config.example.yaml`, `config_version: 31`); env-var values via `$VAR`; resolution order explicit path → `DEER_FLOW_CONFIG_PATH` → project root → legacy backend/repo root [Verified from source: backend/packages/harness/deerflow/config/app_config.py:341-369, 522-545; config.example.yaml:1-18]. `get_app_config()` caches and auto-reloads on path or `(mtime,size,sha256)` signature change; `AppConfig` is `extra="allow"`; null top-level sections fall back to defaults; singleton sub-configs (title/summarization/memory/subagents/tool_search/guardrails/authorization/checkpointer/stream_bridge/acp) are re-published on each load [Verified from source: app_config.py:250, 316-339, 429-464, 606-671]. Restart-required fields are registered in `reload_boundary.STARTUP_ONLY_FIELDS`: `database`, `checkpointer`, `run_events`, `agent_storage`, `stream_bridge`, `sandbox`, `log_level`, `logging`, plus non-schema `channels` etc. [Verified from source: backend/packages/harness/deerflow/config/reload_boundary.py:36-60].

### 7.1 Top-level scalars & logging

| Field | Default | Notes |
|---|---|---|
| `config_version` | 31 (example) | outdated-config warning + `make config-upgrade` [app_config.py:477-520; config.example.yaml:18] |
| `log_level` | `"info"` | deerflow/app loggers only; startup-only [app_config.py:190-196] |
| `logging.enhance.enabled` | `false` | request trace ids (X-Trace-Id / Langfuse `deerflow_trace_id`); startup-only [app_config.py:127-153] |
| `logging.enhance.format` | `"text"` | `text` \| `json` [app_config.py:131] |
| `max_recursion_limit` | `1000` | server-side clamp on client-supplied recursion_limit [app_config.py:206-210] |

[Verified from source: backend/packages/harness/deerflow/config/app_config.py:127-210]

### 7.2 `models[]` (`ModelConfig`, `extra="allow"`)

| Field | Default | Notes |
|---|---|---|
| `name` | required | unique id |
| `display_name`, `description` | `None` | UI metadata |
| `use` | required | provider class path, e.g. `langchain_openai:ChatOpenAI` |
| `model` | required | provider model id |
| `use_responses_api` | `None` | OpenAI /v1/responses routing |
| `output_version` | `None` | e.g. `responses/v1` |
| `supports_thinking` | `False` | gates thinking toggle |
| `supports_reasoning_effort` | `False` | gates reasoning_effort passthrough |
| `when_thinking_enabled` / `when_thinking_disabled` | `None` | extra constructor settings per thinking state |
| `thinking` | `None` | shortcut merged into `when_thinking_enabled["thinking"]` |
| `supports_vision` | `False` | gates view_image / ViewImageMiddleware |
| `context_window` | `None` (>0) | UI context-% indicator only |
| `stream_chunk_timeout` | `None` (factory default 240 s) | OpenAI-compat chunk-gap timeout |
| *(extra keys)* | — | forwarded to the provider constructor (`api_key`, `base_url`, `max_tokens`, `temperature`, `pricing`, ...) |

[Verified from source: backend/packages/harness/deerflow/config/model_config.py:4-61; factory.py:126-134]

### 7.3 `tools[]` / `tool_groups[]`

`ToolConfig`: `name` (required), `group` (required), `use` (required variable path, e.g. `deerflow.sandbox.tools:bash_tool`), `extra="allow"` for provider settings (`max_results`, `api_key`, ...). `ToolGroupConfig`: `name` (required), `extra="allow"`. Example groups: `web`, `file:read`, `file:write`, `bash`, `browser` [Verified from source: backend/packages/harness/deerflow/config/tool_config.py:4-20; config.example.yaml:665-1016].

### 7.4 `sandbox` (`SandboxConfig`, required section, `extra="allow"`, startup-only)

| Field | Default | Notes |
|---|---|---|
| `use` | required | provider class path (`deerflow.sandbox.local:LocalSandboxProvider` in the example) |
| `allow_host_bash` | `False` | required for bash tool on LocalSandboxProvider |
| `image` | `None` | AIO/BoxLite/E2B image |
| `port` | `None` | AIO base port (8080 doc default) |
| `replicas` | `None` (>0) | provider capacity |
| `overflow_policy` | `"wait"` | E2B: `wait`/`reject`/`burst` |
| `acquire_timeout` | `30` | E2B wait policy seconds |
| `burst_limit` | `0` | E2B burst extra slots |
| `container_prefix` | `None` | AIO container names |
| `idle_timeout` | `None` (doc default 600) | warm sandbox idle seconds; 0 disables |
| `health_check_skip_seconds` | `None` (≥0) | BoxLite reclaim skip window |
| `ownership` | `None` | `SandboxOwnershipConfig`: `type` `memory`\|`redis` (default memory), `redis_url` (None → env fallbacks), `renewal_interval_seconds` 30.0, `ttl_multiplier` 4.0 (≥2), `key_prefix` `deerflow:sandbox:owner` |
| `mounts` | `[]` | `VolumeMountConfig`: `host_path` (required), `container_path` (required), `read_only` False |
| `thread_data_mounts` | `None` | AIO: override mount auto-detection |
| `environment` | `{}` | injected into sandbox container; `$VAR` resolved |
| `bash_output_max_chars` | `20000` | middle-truncation (head+tail); 0 disables |
| `read_file_output_max_chars` | `50000` | head-truncation; 0 disables |
| `ls_output_max_chars` | `20000` | head-truncation; 0 disables |
| `bash_command_timeout` | `600` | wall-clock kill for host bash (process group) |
| `provisioner_api_key` | `None` | X-API-Key for the provisioner service |

[Verified from source: backend/packages/harness/deerflow/config/sandbox_config.py:9-202; config.example.yaml:1210-1242]

### 7.5 `skills` (`SkillsConfig`)

| Field | Default | Notes |
|---|---|---|
| `use` | `deerflow.skills.storage.local_skill_storage:LocalSkillStorage` | SkillStorage impl |
| `path` | `None` | resolution: field → `$DEER_FLOW_SKILLS_PATH` → `{project_root}/skills` → legacy repo-root `skills/` |
| `container_path` | `DEFAULT_SKILLS_CONTAINER_PATH` (`/mnt/skills`) | sandbox mount point |
| `deferred_discovery` | `False` | names-only `<skill_index>` + `describe_skill` tool instead of full prompt metadata |

[Verified from source: backend/packages/harness/deerflow/config/skills_config.py:17-64]

### 7.6 `tool_search` (`ToolSearchConfig`)

| Field | Default | Notes |
|---|---|---|
| `enabled` | `False` | defer MCP tool schemas, add `tool_search` |
| `auto_promote_top_k` | `3` | clamped 1..5; McpRoutingMiddleware auto-promotion breadth |

[Verified from source: backend/packages/harness/deerflow/config/tool_search_config.py:14-34]

### 7.7 `tool_output` (`ToolOutputConfig`)

| Field | Default | Notes |
|---|---|---|
| `enabled` | `True` | tool-result budget middleware |
| `externalize_min_chars` | `12000` | above this, output persisted to disk + synopsis; 0 disables externalization |
| `preview_head_chars` / `preview_tail_chars` | `2000` / `1000` | fallback sample sizes in the synopsis |
| `fallback_max_chars` | `30000` | truncation cap when disk unavailable; 0 disables |
| `fallback_head_chars` / `fallback_tail_chars` | `8000` / `3000` | head+tail split |
| `storage_subdir` | `".tool-results"` | under thread outputs |
| `exempt_tools` | `["read_file", "read_file_tool"]` | prevents persist→read→persist loops |
| `tool_overrides` | `{}` | per-tool `externalize_min_chars` |

[Verified from source: backend/packages/harness/deerflow/config/tool_output_config.py:8-62]

### 7.8 `title` (`TitleConfig`)

| Field | Default |
|---|---|
| `enabled` | `True` |
| `max_words` | `6` (1-20) |
| `max_chars` | `60` (10-200) |
| `model_name` | `None` (local fallback title) |
| `prompt_template` | built-in "Generate a concise title..." template |

[Verified from source: backend/packages/harness/deerflow/config/title_config.py:6-32]

### 7.9 `summarization` (`SummarizationConfig`)

| Field | Default | Notes |
|---|---|---|
| `enabled` | `False` | shared switch for lead AND subagent compaction |
| `model_name` | `None` | None = the run's own model; set = that model with run-model fallback |
| `trigger` | `None` | one or list of `ContextSize {type: fraction|tokens|messages, value}` |
| `keep` | `{type: messages, value: 20}` | retention policy |
| `trim_tokens_to_summarize` | `4000` | null skips trimming |
| `summary_prompt` | `None` | custom template |
| `skill_file_read_tool_names` | `["read_file", "read", "view", "cat"]` | skill-context capture |

[Verified from source: backend/packages/harness/deerflow/config/summarization_config.py:7-61]

### 7.10 `memory` (`MemoryConfig` — host-shared only)

| Field | Default | Notes |
|---|---|---|
| `enabled` | `True` | master switch |
| `mode` | `"middleware"` | `middleware` (passive extraction) \| `tool` (model-driven memory tools) |
| `injection_enabled` | `True` | prompt injection gate |
| `shutdown_flush_timeout_seconds` | `30.0` (1-300) | graceful-shutdown drain budget |
| `manager_class` | `"deermem"` | backend name or dotted MemoryManager path; fail-fast |
| `backend_config` | `{}` | backend-private dict (DeerMem knobs: `storage_path`, `debounce_seconds` 30, `max_facts` 100, `fact_confidence_threshold` 0.7, `max_injection_tokens` 2000, `token_counting` tiktoken\|char, `staleness_*`, `consolidation_*`, ...) — legacy top-level keys are auto-migrated into it with warnings |

[Verified from source: backend/packages/harness/deerflow/config/memory_config.py:21-112, 165-228; backend/AGENTS.md "Memory System" configuration list]

### 7.11 `subagents` (`SubagentsAppConfig`)

| Field | Default | Notes |
|---|---|---|
| `timeout_seconds` | `1800` | built-in subagent default (custom agents default 900) |
| `max_turns` | `None` | global override; built-ins: general-purpose 150, bash 60 |
| `max_total_per_run` | `6` (1-50) | total delegation cap per lead run; runtime override `max_total_subagents` clamped to same range |
| `token_budget` | factory default: `enabled: true, max_tokens: 2,000,000 (1,000,000 when summarization.enabled), warn_threshold: 0.7` | per-subagent-run ceiling; user-set value always wins over the summarization coupling |
| `agents.{name}` | `{}` | `SubagentOverrideConfig`: `timeout_seconds`, `max_turns`, `model`, `skills`, `token_budget` (all optional) |
| `custom_agents.{name}` | `{}` | `CustomSubagentConfig`: `description` + `system_prompt` (required), `tools` None, `disallowed_tools` `["task","ask_clarification","present_files"]`, `skills` None, `model` `"inherit"`, `max_turns` 50, `timeout_seconds` 900 |

Concurrency constants (not config fields): per-response `task` concurrency clamped to 1-4 (`MAX_CONCURRENT_SUBAGENT_CALLS`), default runtime 3 [Verified from source: backend/packages/harness/deerflow/config/subagents_config.py:11-153; backend/AGENTS.md "Subagent System"].

### 7.12 Middleware guard sections

**`loop_detection` (`LoopDetectionConfig`)** [Verified from source: backend/packages/harness/deerflow/config/loop_detection_config.py:6-73]:

| Field | Default |
|---|---|
| `enabled` | `True` |
| `warn_threshold` | `3` identical tool-call sets |
| `hard_limit` | `5` (must be ≥ warn) |
| `window_size` | `20` recent call-sets/thread |
| `max_tracked_threads` | `100` |
| `tool_freq_warn` | `30` same-tool calls |
| `tool_freq_hard_limit` | `50` |
| `tool_freq_overrides` | `{}` per-tool `{warn, hard_limit}` |

**`tool_progress` (`ToolProgressConfig`)** [Verified from source: backend/packages/harness/deerflow/config/tool_progress_config.py:6-46]:

| Field | Default |
|---|---|
| `enabled` | `False` |
| `stagnation_threshold` | `3` |
| `warn_escalation_count` | `2` |
| `inject_assessment` | `True` |
| `jaccard_similarity_threshold` | `0.8` |
| `min_word_count_for_similarity` | `10` |
| `exempt_tools` | `{ask_clarification, write_todos, present_files, task}` |
| `max_tracked_threads` | `100` |

**`token_budget` (`TokenBudgetConfig`, per lead run)** [Verified from source: backend/packages/harness/deerflow/config/token_budget_config.py:6-21]:

| Field | Default |
|---|---|
| `enabled` | `False` |
| `max_tokens` | `200000` (≥1000) |
| `max_input_tokens` / `max_output_tokens` | `None` |
| `warn_threshold` | `0.8` |
| `hard_stop_threshold` | `1.0` (≥ warn) |

**Others**: `token_usage.enabled = True` [token_usage_config.py:4-7]; `read_before_write.enabled = True` [read_before_write_config.py:6-18]; `safety_finish_reason.enabled = True`, `detectors = None` (built-ins: OpenAI content_filter, Anthropic refusal, Gemini SAFETY et al.; overridable via `{use, config}` class paths) [safety_finish_reason_config.py:14-47]; `suggestions.enabled = True`, `max_suggestions = 3 (1-5)` [suggestions_config.py:7-16]; `input_polish.enabled = True`, `max_chars = 4000`, `model_name = None` [input_polish_config.py:4-9].

### 7.13 Persistence / infrastructure sections

**`database` (`DatabaseConfig`, startup-only)** [Verified from source: backend/packages/harness/deerflow/config/database_config.py:103-171]:

| Field | Default | Notes |
|---|---|---|
| `backend` | `"memory"` (config.yaml file default: `"sqlite"`) | memory \| sqlite \| postgres; checkpointer + app share it [app_config.py:57-60, 466-475] |
| `checkpoint_channel_mode` | `"full"` | `full` \| `delta`; restart-required, must match across processes |
| `checkpoint_delta.snapshot_frequency` | `10` (≥1) | DeltaChannel snapshot cadence |
| `checkpoint_graph_cache.accessor_graph_max` | `64` (≥1) | hot-reloadable |
| `sqlite_dir` | `".deer-flow/data"` | shared `deerflow.db` |
| `postgres_url` | `""` | shared DSN |
| `echo_sql` | `False` | |
| `pool_size` | `5` | app ORM pool (postgres) |
| `pool_recycle` | `300` | |
| `command_timeout` | `30` | null disables |
| `postgres_schema` | `""` | plain identifier |

**`checkpointer` (legacy `CheckpointerConfig`, optional/None)**: `type` (memory|sqlite|postgres, required when present), `connection_string` (sqlite path or postgres DSN), `postgres_schema` `""`; when present it overrides `database` for the LangGraph checkpointer/store only [Verified from source: backend/packages/harness/deerflow/config/checkpointer_config.py:12-37; backend/AGENTS.md "Persistence backend resolution"].

**`run_events` (`RunEventsConfig`, startup-only)**: `backend` `"memory"` (memory|db|jsonl), `max_trace_content` `10240`, `track_token_usage` `True` [Verified from source: backend/packages/harness/deerflow/config/run_events_config.py:21-33].

**`stream_bridge` (`StreamBridgeConfig`, optional/None, startup-only)**: `type` `"memory"` (memory|redis), `redis_url` `None` (env fallbacks), `queue_maxsize` `256`, `max_connections` `None`, `stream_ttl_seconds` `86400`, `recovered_stream_cleanup_delay_seconds` `60.0` [Verified from source: backend/packages/harness/deerflow/config/stream_bridge_config.py:10-48].

**`run_ownership` (`RunOwnershipConfig`, startup-only)**: `lease_seconds` `30` (≥5), `grace_seconds` `10`, `heartbeat_enabled` `False` [Verified from source: backend/packages/harness/deerflow/config/run_ownership_config.py:32-47].

**`scheduler` (`SchedulerConfig`, startup-only)**: `enabled` `False`, `poll_interval_seconds` `5`, `lease_seconds` `120`, `max_concurrent_runs` `3`, `min_once_delay_seconds` `60` [Verified from source: backend/packages/harness/deerflow/config/scheduler_config.py:4-9].

**`agent_storage`**: `backend` `"file"` (file|db) for custom-agent definitions [Verified from source: backend/packages/harness/deerflow/config/agent_storage_config.py:27-37]. **`agents_api`**: `enabled` `False` (HTTP management of SOUL.md/config/USER.md) [agents_api_config.py:6-12]. **`dedupe_storage`**: `backend` `"auto"` (auto|memory|postgres) for webhook dedupe [dedupe_storage_config.py:19-41].

**LLM infra**: `circuit_breaker` (`failure_threshold` 5, `recovery_timeout_sec` 60) and `llm_call` (`max_concurrent_calls` 0 = uncapped/startup-frozen, `retry_max_attempts` 3, `retry_base_delay_ms` 1000, `retry_cap_delay_ms` 8000, `burst_retry_base_delay_ms` 5000) [Verified from source: app_config.py:63-124].

### 7.14 Skills-safety, agents, auth, channels (brief)

- `skill_scan.enabled = True` (deterministic SkillScan before the LLM scanner) [skill_scan_config.py:6-12]; `skill_evolution` = `{enabled: False, moderation_model_name: None, security_fail_closed: True}` [skill_evolution_config.py:4-18].
- `AgentConfig` (custom agents, stored per-user as `config.yaml` + `SOUL.md`, not in the main config): `name`, `description ""`, `model None`, `tool_groups None`, `skills None` (None = all enabled, [] = none), `model_settings` (`temperature` 0-2 / `max_tokens` ≤200k overrides, `extra="forbid"`), `thinking_enabled None`, `reasoning_effort None`, `github` block (`installation_id`, `bot_login`, `recursion_limit`, `bindings[].{repo, triggers}`) [Verified from source: backend/packages/harness/deerflow/config/agents_config.py:46-238].
- `auth` (`AuthAppConfig`): local auth (`allow_registration`, ...) + OIDC providers (`scopes`, `token_endpoint_auth_method`, `auto_create_users`, `require_verified_email`, `allowed_email_domains`, `admin_emails`, endpoint overrides) [Verified from source: backend/packages/harness/deerflow/config/auth_config.py:10-84]. `channel_connections`: per-provider (slack/telegram/discord/feishu/dingtalk/wechat/wecom) user-binding configs [channel_connections_config.py:8-52]. `acp_agents.{name}`: `auto_approve_permissions`, `timeout_seconds` per external ACP agent [acp_config.py:11-27]. `uploads` (config.yaml section consumed by the gateway): `max_files` 10, `max_file_size` 50 MiB, `max_total_size` 100 MiB, `auto_convert_documents` false, `pdf_converter` auto [Verified from source: config.example.yaml:1190-1208].

### 7.15 `extensions_config.json` (`ExtensionsConfig`)

| Field | Default | Notes |
|---|---|---|
| `middlewares` | `[]` | `module.path:ClassName` AgentMiddleware entries (zero-arg); config.yaml `extensions:` overrides per-field |
| `mcpServers.{name}` | `{}` | `McpServerConfig`: `enabled` True, `type` "stdio" (alias `transport`), `command`/`args`/`env` (stdio), `url`/`headers` (sse/http), `oauth` (McpOAuthConfig: `enabled` True, `token_url` required, `grant_type` client_credentials, client id/secret, refresh_token, scope, audience, `token_field` access_token, `token_type_field`, `expires_in_field`, `default_token_type` Bearer, `refresh_skew_seconds` 60, `extra_token_params`), `description` "", `routing` (`mode` off\|prefer, `priority` 0 clamped 0-100, `keywords` []), `tools.{orig_name}.routing` overrides, `tool_call_timeout` None (stdio only) |
| `skills.{name}` | `{}` | `{enabled: true}`; unlisted skills default to enabled |
| `mcpInterceptors` (extra) | — | list of `pkg.module:builder_func` interceptor builders |

Resolution: explicit path → `$DEER_FLOW_EXTENSIONS_CONFIG_PATH` → project root `extensions_config.json`/`mcp_config.json` → legacy roots → `None` (optional); explicit/env paths that are missing raise. `$VAR` values resolve to env, with *missing* vars mapped to `""` (unlike config.yaml, which raises). Writes go through `atomic_write_extensions_config` (same-dir tmp + fsync + `os.replace`, mode/symlink-preserving) under `extensions_config_write_lock` [Verified from source: backend/packages/harness/deerflow/config/extensions_config.py:28-327, 333-428; extensions_config.example.json:1-59; backend/packages/harness/deerflow/mcp/tools.py:619-641].

### 7.16 Path/env knobs (`runtime_paths.py`, `paths.py`)

`DEER_FLOW_PROJECT_ROOT` (project root, must exist), `DEER_FLOW_HOME` (state dir, default `{project_root}/.deer-flow`), `DEER_FLOW_HOST_BASE_DIR` (host-side path for DooD volume mounts), `DEER_FLOW_SKILLS_PATH`, `DEER_FLOW_CONFIG_PATH`, `DEER_FLOW_EXTENSIONS_CONFIG_PATH` [Verified from source: backend/packages/harness/deerflow/config/runtime_paths.py:7-31; paths.py:128-161; skills_config.py:37-64].

---

## 8. Port-relevant observations

A Claude Code port replaces DeerFlow's model layer, graph runtime, and server persistence with the Claude Code harness. Sorting the config surface accordingly:

**Becomes irrelevant (owned by Claude Code / dropped):**

- The entire `models[]` section and every provider adapter in `harness/models/` — Claude Code owns model selection, auth, retries, streaming, prompt caching, and thinking budgets natively. Notably `claude_provider.py` is itself an emulation of Claude Code's OAuth + billing-header behavior (loads `~/.claude/.credentials.json`, sends `anthropic-beta: oauth-2025-04-20,claude-code-20250219`, injects the CLI billing block), so the port deletes rather than translates it [Verified from source: claude_provider.py:1-41; credential_loader.py:149-196].
- Model-call shaping knobs that exist only because DeerFlow drives raw providers: `llm_call.*`, `circuit_breaker.*`, `stream_chunk_timeout`, thinking enable/disable transforms in the factory [Verified from source: app_config.py:63-124; factory.py:239-270].
- Server infrastructure sections: `database`, `checkpointer`, `run_events`, `stream_bridge`, `run_ownership`, `dedupe_storage`, `agent_storage`, `scheduler`, `auth`, `channel_connections`, `agents_api`, and the reload-boundary machinery — all exist for the multi-worker Gateway/LangGraph runtime, which Claude Code's session model supersedes [Verified from source: reload_boundary.py:45-60; database_config.py:103-171].
- Gateway-UI features: `title`, `suggestions`, `input_polish`, `token_usage` (Claude Code has its own equivalents or no need) [Verified from source: title_config.py:6-32; suggestions_config.py:7-16; input_polish_config.py:4-9].
- MCP transport plumbing that duplicates Claude Code's built-in MCP client (`MultiServerMCPClient`, session pool, OAuth token manager) — though see the behavior knobs below for what should survive as policy.

**Must be preserved as behavior knobs (they encode agent-quality/safety policy, not infrastructure):**

- **Loop/progress/budget guards**: `loop_detection` thresholds (warn 3 / hard 5 identical call-sets, tool-frequency 30/50 with per-tool overrides), `tool_progress` stagnation state machine (3 + 2 escalation, Jaccard 0.8), `token_budget` (200k lead default when enabled, 0.8 warn / 1.0 stop), and the subagent token-budget backstop (enabled by default, 2M / 1M coupled to summarization, warn 0.7) [Verified from source: loop_detection_config.py:24-73; tool_progress_config.py:6-46; token_budget_config.py:6-21; subagents_config.py:28-55].
- **Subagent caps**: per-response concurrency clamp 1-4 (default 3), `max_total_per_run` 6 (1-50), timeouts 1800 s built-in / 900 s custom, built-in `max_turns` general-purpose 150 / bash 60, custom-agent default deny-list `["task","ask_clarification","present_files"]` [Verified from source: subagents_config.py:11-153; backend/AGENTS.md "Subagent System"].
- **Summarization/compaction policy**: trigger/keep `ContextSize` semantics, keep default 20 messages, `trim_tokens_to_summarize` 4000, and the shared lead/subagent switch [Verified from source: summarization_config.py:22-61].
- **Tool-output budgets**: `tool_output` externalize-at-12k / fallback 30k head+tail, read-tool exemptions; sandbox truncation (`bash_output_max_chars` 20000 middle-truncated, `read_file` 50000, `ls` 20000) and `bash_command_timeout` 600 s with process-group kill — these define what the model sees and must be reproduced in any Bash/Read tool shim [Verified from source: tool_output_config.py:8-62; sandbox_config.py:168-190; local_sandbox.py:24-31, 598-614].
- **Sandbox path & secrecy contract**: the `/mnt/user-data/{workspace,uploads,outputs}` + `/mnt/skills` virtual layout with per-user/thread physical isolation, read-only skill projections, host-path masking in output, the env scrub patterns (`*KEY*/*SECRET*/*TOKEN*/*PASS*/*CREDENTIAL*/*DSN*` + exact denylist) with injected-secret override, and `allow_host_bash` fail-closed default [Verified from source: paths.py:102-127; local_sandbox_provider.py:279-359; env_policy.py:24-112; security.py:35-45].
- **File-edit discipline**: `read_before_write.enabled` default true (hash-gated writes) and per-(sandbox,path) write serialization [Verified from source: read_before_write_config.py:6-18; file_operation_lock.py:13-27].
- **Workspace-change review**: the pre/post-run snapshot+diff limits (200 files / 2000 scanned / 256 KiB per-file / 1 MiB total, sensitive-path metadata-only rule) are user-facing behavior worth carrying to any port that surfaces "what changed this run" [Verified from source: types.py:18-27; scanner.py:68-95].
- **MCP policy**: deferred-tool discovery (`tool_search.enabled`, `auto_promote_top_k` 1..5), routing hints, stdio cwd/TMPDIR pinning into the thread workspace, and result path translation into the virtual tree — Claude Code's MCP client covers transport, but these DeerFlow behaviors (context economy + files landing where artifacts are served) are policy that needs an equivalent [Verified from source: tool_search_config.py:14-34; tools.py:41-46, 464-495, 93-140].
- **Skills & memory behavior**: `skills.deferred_discovery`, enabled-state model in `extensions_config.json`, and the memory backend knobs (debounce 30 s, max_facts 100, confidence 0.7, injection 2000 tokens, staleness/consolidation) if memory is ported [Verified from source: skills_config.py:32-35; extensions_config.py:308-327; backend/AGENTS.md memory configuration list].
- **Upload hygiene**: staging-file convention (`.upload-*.part`), `_N` collision suffixes, symlink/hardlink-refusing writes — required wherever uploads land in a sandbox-writable directory [Verified from source: manager.py:29-31, 74-96, 166-259].
