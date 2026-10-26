/**
 * Guardian-side glue for the section gate. Detects invented and
 * missing sections in a body, asks the pure decision what to do,
 * and persists a new signature when it blocks. The decision
 * logic lives in the sections and gate modules; this is only the
 * read/persist wiring against a caller-supplied signature store.
 */

import type { GateDeps } from "../../gate/index.ts";
import type { GuardianResult } from "../../guardian/types.ts";
import {
	type SectionGateConfig,
	sectionGateDecision,
} from "../../sections/index.ts";

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

/**
 * The relent message, when the section gate is letting this exact
 * body through after already blocking it once, else null. See
 * prose-gate.ts's `proseGateNote` for why this exists: a caller
 * whose "ask" is a synthesized summary, not a full render of the
 * body, needs to say a relent happened rather than staying silent.
 */
export function sectionGateNote(
	deps: GateDeps,
	body: string | null,
	config: SectionGateConfig,
): string | null {
	if (!body) return null;
	const decision = sectionGateDecision(body, deps.readSignatures(), config);
	return decision.action === "relent" ? decision.message : null;
}
