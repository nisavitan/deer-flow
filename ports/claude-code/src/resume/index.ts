// M10 checkpoints & resume: stale-state detection, crash/orphan recovery, and the resume
// report that `/deerflow:status` renders.
//
// The design these modules implement is docs/claude-code-port/state-checkpoint-resume.md
// §3 (resume paths), §4 (stale-state detection) and §5 (crash recovery). They read and write
// only through src/state/* — the atomic-write + `rev`-CAS discipline is never bypassed.
export * from './staleness.js'
export * from './recovery.js'
export * from './resume-plan.js'
export * from './git-head.js'
