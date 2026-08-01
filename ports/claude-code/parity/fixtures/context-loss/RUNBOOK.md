# Context-loss measurement runbook

Two live measurements. Both answer the same question — *what did the session still know afterwards?* — and neither is computable from source, which is why they live here as commands rather than as tests.

- **(a) resume-recall** — seed a session, resume it fresh, ask the probes. Fully scriptable, no human in the loop.
- **(b) compaction-recall** — the same, with `/compact` between the seed and the probes. **Joint-session: requires an interactive `/compact`.**

Why measure instead of assert: `parity/DISCREPANCIES.md` §M8 entry 2 records that the prose summary is produced by Claude Code's native compaction, which the port neither controls nor inspects. Asserting "the thread still works after compaction" proves nothing about what was dropped. These runs make the loss a number.

---

## 0. Prerequisites

```bash
cd ports/claude-code
npm install
npm run build            # produces dist/summary/context-loss-cli.js
```

Verify the scorer is present and healthy before spending a live session on it:

```bash
npx vitest run src/summary/context-loss-cli.test.ts   # 28 tests, exit 0
```

Set the paths once per shell:

```bash
export PORT_DIR="$PWD"                       # .../ports/claude-code
export FIXTURE="$PORT_DIR/parity/fixtures/context-loss/case-01.json"
export RUNDIR="$(mktemp -d)/context-loss"    # scratch: transcripts and answers
mkdir -p "$RUNDIR"
```

Run **case-01** and **case-02** as separate sessions. Never seed both into one session: case-02's items are deliberately more abstract, and mixing them lets a recall of one stand in for the other.

---

## 1. Build the seed prompt from the fixture

The seed prompt states every item verbatim. Generating it from the fixture rather than writing it by hand is the point: the thing measured is exactly the thing seeded.

Each item carries two strings. `text` is the **match key** the scorer greps for; `seed` is the natural sentence that goes into the prompt, so the session gets a realistic briefing instead of a list of bare tokens. Every `seed` contains its own `text` verbatim — asserted by `src/summary/context-loss-cli.test.ts`, so a fixture edit cannot brief the session on one string and grade it on another.

```bash
python3 - "$FIXTURE" > "$RUNDIR/seed.txt" <<'PY'
import json, sys
fx = json.load(open(sys.argv[1]))
lines = ["Here is the context for our session. Acknowledge it briefly and hold on to it; I will ask about it later.", ""]
for field, label in (("facts", "Facts"), ("decisions", "Decisions and constraints"), ("files", "Files")):
    items = fx.get(field) or []
    if not items:
        continue
    lines.append(f"{label}:")
    lines += ["- " + (item.get("seed") or item["text"]) for item in items]
    lines.append("")
lines.append("Reply with just: ACKNOWLEDGED.")
sys.stdout.write("\n".join(lines))
PY
```

And the probe prompt, which asks every question in one turn (the scorer concatenates all answers before matching — it measures whether the information survived at all, not which question recovered it):

```bash
python3 - "$FIXTURE" > "$RUNDIR/probe.txt" <<'PY'
import json, sys
fx = json.load(open(sys.argv[1]))
lines = ["Answer each question from what you already know about this session. "
         "Do not read any files, do not search, and do not guess: if you no longer "
         "know something, write exactly UNKNOWN for that question.", ""]
lines += [f"{i}. {p['question']}" for i, p in enumerate(fx["probes"], start=1)]
sys.stdout.write("\n".join(lines))
PY
```

> **Do not let the model recover the answers from disk.** The probe prompt forbids tool use, and the run below is launched from `$RUNDIR` (an empty scratch directory) so there is nothing to read. A session that greps the fixture out of the repo scores 100% and measures nothing.

---

## 2. Measurement (a) — resume-recall

Seed a session, capture its id, then resume it in a **fresh process** and ask the probes.

```bash
cd "$RUNDIR"

# Turn 1 — seed. --output-format json gives us the session_id to resume.
claude -p "$(cat "$RUNDIR/seed.txt")" \
  --plugin-dir "$PORT_DIR" \
  --output-format json \
  > "$RUNDIR/seed-result.json"

SESSION_ID=$(python3 -c "import json;print(json.load(open('$RUNDIR/seed-result.json'))['session_id'])")
echo "session: $SESSION_ID"

# Turn 2 — resume in a new process and probe.
claude -p "$(cat "$RUNDIR/probe.txt")" \
  --resume "$SESSION_ID" \
  --plugin-dir "$PORT_DIR" \
  --output-format json \
  > "$RUNDIR/probe-result.json"
```

Score it:

```bash
python3 -c "
import json
r = json.load(open('$RUNDIR/probe-result.json'))
print(json.dumps({'answers': [r['result']]}))
" | node "$PORT_DIR/dist/summary/context-loss-cli.js" --fixture "$FIXTURE" --pretty \
  | tee "$RUNDIR/score-resume.json"
```

Output is a `RecallScore`: `items_total`, `items_recalled`, `recall_rate`, `lost_items` (every item that did not survive, by id and kind) and `by_kind` (loss attributed to facts / decisions / files).

**Expected result: `recall_rate` near 1.0.** A plain `--resume` replays the transcript, so this run is the **control**. It establishes that the seed prompt, the probe prompt and the scorer's match keys all work. If (a) does not score high, the fixture is at fault, not the platform — fix it before running (b), or (b)'s number means nothing.

Add `--fail-under 0.9` to turn the control into a gate that exits 2 rather than printing a number nobody reads.

---

## 3. Measurement (b) — compaction-recall

**Joint-session: requires an interactive `/compact`.** `/compact` is a slash command in the interactive REPL; it is not model-invocable and has no `-p` equivalent, so this measurement cannot be scripted end to end. That limitation is the same one recorded in `parity/DISCREPANCIES.md` §M8 entry 7 ("Manual compaction is two actions by two actors") — the port's `/deerflow:compact` refreshes the durable digest, and only the user's `/compact` shrinks the context.

Run it as a joint session:

```bash
cd "$RUNDIR"
claude --plugin-dir "$PORT_DIR"
```

Then, in the REPL:

1. **Seed** — paste the contents of `$RUNDIR/seed.txt`. Wait for `ACKNOWLEDGED`.
2. **Fill the window** — the seed alone will not reach the compaction threshold (~85% of the window). Give the session real work until it does; reading a large directory tree is the cheapest filler:
   `Read every file under <some large directory> and summarise each in one line.`
3. **Compact** — run `/compact`. If auto-compaction has already fired, note that instead; either boundary is a valid measurement, and the `PreCompact` hook fires for both.
4. **Confirm the port's half ran** — in another shell:
   `cat .deerflow/state/*/summary.json` — `updated_at` must be at or after the compaction, and `compaction.trigger` records `auto` or `manual`. If `summary.json` is missing, the plugin was not loaded and the run is void.
5. **Probe** — paste the contents of `$RUNDIR/probe.txt`.
6. **Capture** — copy the model's full answer into `$RUNDIR/answers-compact.txt`.

Score it:

```bash
python3 -c "
import json
print(json.dumps({'answers': [open('$RUNDIR/answers-compact.txt').read()]}))
" | node "$PORT_DIR/dist/summary/context-loss-cli.js" --fixture "$FIXTURE" --pretty \
  | tee "$RUNDIR/score-compaction.json"
```

**This number is the measurement.** `recall_rate(b)` is post-compaction recall; `recall_rate(a) − recall_rate(b)` is the loss attributable to compaction, with the control's own imperfections subtracted out. `by_kind` says *what* was lost — the port's own expectation, from `DISCREPANCIES.md` §M8 entry 2, is that `file` paths survive best (they are in `summary.json`'s digest) and free-standing `fact` items survive worst (they exist only in the prose the port does not control).

---

## 4. Reading the number honestly

- **The scorer is pessimistic by construction.** `src/summary/context-loss.ts` matches literally, with aliases, never semantically. A model that recalls an item in words no alias covers scores as lost. The reported `recall_rate` is therefore a **floor**: it can under-report recall, never over-report it. Never present it as an upper bound.
- **`case-01` vs `case-02` measure different things.** case-01's keys are distinctive tokens (a ticket id, a commit sha, a full path) — it measures *token* survival. case-02's items are concepts with paraphrase-tolerant alias sets — it measures *meaning* survival. Run both. A large gap (case-02 high, case-01 low) is the signature of compaction keeping the gist and dropping the specifics, which is precisely the behaviour the port cannot control.
- **N=1 is not a result.** Compaction is model-shaped. Per `parity-test-plan.md`'s statistical protocol, scenario S13 is an `[S]` assertion at N=5. Run (b) five times and report the median plus the range, not a single figure.
- **Record the platform version.** `claude --version` next to every score. This measurement is of a platform the port does not own, and it will move.

Suggested record, one row per run, appended to `parity/fixtures/context-loss/RESULTS.md` (create it on the first real run — it is deliberately not committed empty):

| date | case | mode | claude version | items | recalled | rate | lost (by kind) |
|---|---|---|---|---|---:|---:|---|
