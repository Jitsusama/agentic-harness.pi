/**
 * Guardian-side glue for the section gate. Detects invented and
 * missing sections in a body, asks the pure decision what to do,
 * and persists a new signature when it blocks. The decision
 * logic lives in the sections and gate modules; this is only the
 * read/persist wiring against a caller-supplied signature store.
 */

import type { GateDeps } from "../../../gate/index.ts";
import type { GuardianResult } from "../../../guardian/types.ts";
import {
	type SectionGateConfig,
	sectionGateDecision,
} from "../../sections/gate.ts";

/** Run the section gate over a body. Returns a block or undefined. */
export function runSectionGate(
	deps: GateDeps,
	body: string | null,
	config: SectionGateConfig,
): GuardianResult {
	if (!body) return undefined;

	const decision = sectionGateDecision(body, deps.readSignatures(), config);

	if (decision.action === "block") {
		deps.persistSignature(decision.signature);
		return { block: true, reason: decision.message };
	}

	// On relent the AI already had its chance and could not satisfy
	// the section set, so blocking again would loop. Fall through to
	// the human review gate (undefined); the user sees the rendered
	// body and can reject it. On allow we also fall through.
	return undefined;
}
