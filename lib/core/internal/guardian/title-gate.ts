/**
 * Guardian-side glue for the title gate. Detects conventional
 * commit format in a PR or issue title, asks the pure decision
 * what to do, and persists a new signature when it blocks. The
 * decision logic lives in the title and gate modules; this is only
 * the read/persist wiring against a caller-supplied signature store.
 */

import type { GateDeps } from "../../../gate/index.ts";
import type { GuardianResult } from "../../../guardian/types.ts";
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
