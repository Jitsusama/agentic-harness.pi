/**
 * Per-stage discipline: the short, agent-facing reminder the
 * workflow returns when a stage is entered. It rides the
 * transition reply, not every turn, so it nudges at the moment
 * the agent asks rather than nagging. The idle text stays
 * neutral and non-coercive: nothing is active, so nothing is
 * demanded.
 */

import type { Stage } from "./machine.js";

const DISCIPLINE: Record<Stage, string> = {
	idle: "No plan is active. Start one when you want to think a problem through before touching code.",
	think:
		"Read-only. Dig hard before you form a view, then debate: surface tradeoffs, float alternatives, push back where you disagree. One thread at a time, high level first. Ask only when something genuinely blocks you.",
	plan: "Read-only except the plan document. Draft it now: capture the spirit, the approach and a sequenced checklist. Keep it lean; the sections are a starting shape, not a cage.",
	build:
		"Implement against the plan. Keep the document current as you go: check off work and log what you discover. A change to the spirit or the approach needs the user's consent; everything smaller, just do and record it.",
	concluded: "This plan is concluded. The document is the record.",
	retired: "This plan is retired. The document holds why.",
};

/** The standing discipline for a stage. */
export function disciplineFor(stage: Stage): string {
	return DISCIPLINE[stage];
}
