/**
 * systema-core — the pure kernel (DECOSTUME Phase 1).
 *
 * Everything here is deterministic: no I/O, no env, no wall clock, no randomness.
 * The reducer is the rules; the log is the truth; projections are downstream.
 */
export * from "./types"
export { canonical, hashOf, sha256, ZERO64 } from "./canonical"
export { GENESIS_DIALS, dialBig, dialBool, dialNum } from "./dials"
export { quorumMinJudges, activeJudges, quorumCrossing, settleVotes, settleStakes, acceptanceRepMilli, coinRewardBase } from "./math"
export { initState, validate, applyEvent, fold, activatePending } from "./reducer"
export { LogSim, sigPayload } from "./sequencer"
export { INVARIANTS, checkInvariants } from "./invariants"
export { fingerprintOf, ed25519Verify, realVerifier, verifyLog } from "./verify"
