/**
 * Guardian-side glue for the title gate. Detects conventional
 * commit format in a PR or issue title, asks the pure decision
 * what to do, and persists a new signature when it blocks. The
 * decision logic lives in the title and gate modules; this is only
 * the read/persist wiring against a caller-supplied signature store.
 */

import type { GateDeps } from "../../../gate/index.ts";
import type { GuardianResult } from "../../guardian/types.ts";
import { type TitleGateConfig, titleGateDecision } from "../../title/index.ts";

/** Run the title gate over a title. Returns a block or undefined. */
export function runTitleGate(
	deps: GateDeps,
	title: string | null,
	config: TitleGateConfig,
): GuardianResult {
	if (!title) return undefined;

	const decision = titleGateDecision(title, deps.readSignatures(), config);

	if (decision.action === "block") {
		deps.persistSignature(decision.signature);
		return { block: true, reason: decision.message };
	}

	// On relent the AI already had its chance and could not satisfy
	// the title convention, so blocking again would loop. Fall
	// through to the human review gate (undefined); the user sees the
	// title and can reject it. On allow we also fall through.
	return undefined;
}

/**
 * The relent message, when the title gate is letting this exact
 * title through after already blocking it once, else null. See
 * prose-gate.ts's `proseGateNote` for why this exists: a caller
 * whose "ask" is a synthesized summary, not a full render of the
 * title, needs to say a relent happened rather than staying silent.
 */
export function titleGateNote(
	deps: GateDeps,
	title: string | null,
	config: TitleGateConfig,
): string | null {
	if (!title) return null;
	const decision = titleGateDecision(title, deps.readSignatures(), config);
	return decision.action === "relent" ? decision.message : null;
}
