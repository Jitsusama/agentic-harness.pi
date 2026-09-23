/**
 * Compaction: the decision logic for when summarising context pays for
 * itself, and the guard that keeps a reserve setting from breaking that
 * decision.
 *
 * Pure and standalone. Neither module touches pi's live compaction
 * behaviour; wiring either into a running trigger is a separate,
 * consequential change from writing the decision itself.
 */

export { type PaybackInput, paybackMargin, paybackTest } from "./payback.js";
export { clampReserveTokens } from "./reserve.js";
