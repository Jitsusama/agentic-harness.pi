/**
 * Guardian-side glue for the prose gate. Detects prose
 * violations in a body, asks the pure decision what to do, and
 * persists a new signature when it blocks. The decision logic
 * lives in the prose and gate modules; this is only the
 * read/persist wiring against a caller-supplied signature store.
 *
 * The signature store itself (`GateDeps`) is deliberately not
 * implemented here: reading and persisting a "have I blocked this
 * before" signature means something different per adapter (pi
 * keeps it in its session log; a stateless CLI would keep it in
 * its own state file). Each adapter supplies its own `GateDeps`.
 */

import type { GateDeps } from "../../gate/index.ts";
import type { GuardianResult } from "../../guardian/types.ts";
import { detectProseViolations, proseGateDecision } from "../../prose/index.ts";

export type { GateDeps };

/** Run the prose gate over a body. Returns a block or undefined. */
export function runProseGate(
	deps: GateDeps,
	body: string | null,
): GuardianResult {
	if (!body) return undefined;

	const violations = detectProseViolations(body);
	const decision = proseGateDecision(violations, deps.readSignatures(), body);

	if (decision.action === "block") {
		deps.persistSignature(decision.signature);
		return { block: true, reason: decision.message };
	}

	// On relent the AI already had its chance and could not satisfy
	// the rule, so blocking again would loop. Fall through to the
	// normal human review gate (undefined) and let the user be the
	// safety net; they see the rendered body and can reject it. On
	// allow we also fall through. Either way we record nothing new.
	return undefined;
}

/**
 * The relent message, when the prose gate is letting this exact
 * body through after already blocking it once, else null.
 *
 * A caller that only reads `runProseGate`'s block-or-undefined
 * result cannot tell "clean" and "relented" apart, since both fall
 * through to undefined by design (see above). pi's own review UI
 * doesn't need to tell them apart either, since it renders the body
 * in full regardless. A caller whose "ask" is a synthesized summary
 * (a Claude Code hook's permission reason) does need to, so a
 * relented violation is not silently reported as clean.
 */
export function proseGateNote(
	deps: GateDeps,
	body: string | null,
): string | null {
	if (!body) return null;
	const violations = detectProseViolations(body);
	const decision = proseGateDecision(violations, deps.readSignatures(), body);
	return decision.action === "relent" ? decision.message : null;
}
