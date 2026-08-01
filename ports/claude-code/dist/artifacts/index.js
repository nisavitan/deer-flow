// M13 artifacts & workspace changes: the port of DeerFlow's `workspace_changes` package plus the
// run-worker delivery verdict it fed. Three modules, one each for the three original concerns:
//   ./snapshot.ts          scanner.py + diff.py + types.py — snapshot, delta, limits
//   ./workspace-changes.ts recorder.py + api.py            — the per-turn record and its history
//   ./delivery.ts          worker.py's delivery verdict    — produced vs presented, and the receipt
// The two hooks that drive them are src/hooks/turn-snapshot.ts (pre) and src/hooks/delivery-gate.ts
// (post).
export * from './snapshot.js';
export * from './workspace-changes.js';
export * from './delivery.js';
