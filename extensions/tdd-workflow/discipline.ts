/**
 * The standing discipline for each phase: the one or two
 * sentences the agent should keep in mind while it's there. The
 * caller injects these as a reminder, both in the tool's reply
 * when a transition lands and in the persistent context so the
 * discipline survives a long autonomous run. The machine owns
 * the refusal guidance; this module owns the reminders.
 */

import type { Phase } from "./machine.js";

const DISCIPLINE: Record<Phase, string> = {
	idle:
		"No loop is active. Start one when you're ready for the next single " +
		"increment.",
	plan:
		"One increment. Describe the intent: the behaviour you want, not the " +
		"code that already exists.",
	write:
		"Bind the test to the exported surface only. Internals are never tested " +
		"directly. If the test is hard to write, the design is wrong, so " +
		"redesign the interface before you go on.",
	red:
		"The failure has to be a real assertion, not a missing symbol or a " +
		"compile error. For a wrong red, stub a minimal skeleton and nothing " +
		"more.",
	green:
		"Write the minimum code to pass. No fictional futures. Do not touch the " +
		"test to make it green.",
	refactor:
		"Behaviour preserved, tests stay green. Step back and reconsider the " +
		"internal and external design now that a real consumer need exists.",
};

/** The standing discipline to keep in mind during a phase. */
export function disciplineFor(phase: Phase): string {
	return DISCIPLINE[phase];
}
