/**
 * Guardian-side glue for the prose gate. Detects prose
 * violations in a body, asks the pure decision what to do, and
 * persists a new signature when it blocks. The decision logic
 * lives in lib/prose and lib/gate; this is only the read/persist
 * wiring against the shared session store.
 */

import type { GateDeps } from "../../gate/index.js";
import type { GuardianResult } from "../../guardian/types.js";
import { detectProseViolations, proseGateDecision } from "../../prose/index.js";
import { sessionGateDeps } from "../gate/session-deps.js";

export type { GateDeps };
export { sessionGateDeps };

/** Run the prose gate over a body. Returns a block or undefined. */
export function runProseGate(
	deps: GateDeps,
	body: string | null,
): GuardianResult {
	if (!body) return undefined;

	const violations = detectProseViolations(body);
	const decision = proseGateDecision(violations, deps.readSignatures());

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
