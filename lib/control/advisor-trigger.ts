import type { PressureReading } from "./pressure.ts";

/**
 * A cheap, deterministic gate on an expensive call, the same shape as
 * core's `isSubstantiveTurn`: a pressure reading only escalates to the
 * advisor once it is genuinely critical. Elevated is a watch, not a
 * call: escalating on every elevated reading would turn "an extra
 * trigger" into the advisor's main reason to run at all, which is a
 * cost decision the plan is explicit belongs to a person, not to a
 * threshold picked in passing.
 *
 * This decides the trigger condition only. Whether the advisor is even
 * enabled, and whether this condition is actually wired into its
 * `turn_end` handler, are separate, deliberate steps: the advisor is
 * off right now, and re-enabling it, or widening why it runs, is
 * exactly the kind of decision that carries a cost the ledger has to
 * show, not one this function should make on its own by existing.
 */
export function pressureTriggersAdvisor(reading: PressureReading): boolean {
	return reading.overall === "critical";
}
