/**
 * The advisor's findings: their shape, how they parse out of a
 * model reply, and how severity plus a back-off counter decide
 * the delivery channel.
 *
 * An aside is a quiet tail note. A concern or blocker interrupts
 * through the steer channel so it can stop a wrong direction
 * rather than only annotate it. A back-off window keeps the
 * advisor from nagging: for a few turns after one interrupt, its
 * later concerns route to asides instead.
 */

/** How loudly a finding should be delivered. */
export type Severity = "aside" | "concern" | "blocker";

/** Where a finding is delivered. */
export type Channel = "aside" | "steer";

/** One evidence-backed observation from the advisor. */
export interface Finding {
	readonly severity: Severity;
	readonly claim: string;
	readonly evidence?: string;
}

/** Turns to route interrupts to asides after one fires. */
export const IMMUNE_WINDOW = 2;

const SEVERITIES: readonly Severity[] = ["aside", "concern", "blocker"];

function isSeverity(value: unknown): value is Severity {
	return typeof value === "string" && SEVERITIES.includes(value as Severity);
}

/**
 * Parse a model reply into findings. Accepts a JSON array of
 * objects anywhere in the reply; anything without a known
 * severity and a non-empty claim is dropped. A reply with no
 * parseable array yields no findings.
 */
export function parseFindings(reply: string): Finding[] {
	const match = reply.match(/\[[\s\S]*\]/);
	if (!match) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[0]);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const findings: Finding[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const claim = typeof record.claim === "string" ? record.claim.trim() : "";
		if (claim.length === 0 || !isSeverity(record.severity)) continue;
		const evidence =
			typeof record.evidence === "string" && record.evidence.trim().length > 0
				? record.evidence.trim()
				: undefined;
		findings.push({
			severity: record.severity,
			claim,
			...(evidence ? { evidence } : {}),
		});
	}
	return findings;
}

/**
 * Decide the channel for a finding given the current back-off
 * counter. Asides always stay asides; concerns and blockers
 * interrupt through steer unless the advisor is still inside its
 * immune window, where they soften to asides.
 */
export function channelFor(severity: Severity, immuneTurns: number): Channel {
	if (severity === "aside") return "aside";
	return immuneTurns > 0 ? "aside" : "steer";
}

/**
 * The back-off counter for the next turn: reset to the immune
 * window when an interrupt fired this turn, otherwise decay by
 * one toward zero.
 */
export function nextImmuneTurns(
	current: number,
	firedInterrupt: boolean,
): number {
	if (firedInterrupt) return IMMUNE_WINDOW;
	return Math.max(0, current - 1);
}
