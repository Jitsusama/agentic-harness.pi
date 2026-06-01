/**
 * Guardian-side glue for the prose gate. Reads the prose-block
 * signatures recorded this session, asks the pure decision what
 * to do with a body, persists a new signature when it blocks,
 * and returns a guardian result. The decision logic lives in
 * lib/prose; this is only the read/persist wiring so the
 * extension can supply session-backed implementations.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { GuardianResult } from "../../guardian/types.js";
import { detectProseViolations, proseGateDecision } from "../../prose/index.js";

/** Session-backed signature store the gate reads and writes. */
export interface ProseGateDeps {
	/** Every prose-block signature recorded this session. */
	readSignatures: () => string[];
	/** Record a new block signature. */
	persistSignature: (signature: string) => void;
}

/** The custom session-entry type that holds a prose-block signature. */
const PROSE_BLOCK_ENTRY = "prose-block-signature";

/**
 * Build session-backed gate deps. Signatures are read from the
 * session entries and persisted as custom entries, so the
 * relent logic survives across gate fires within a session.
 */
export function sessionProseGateDeps(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): ProseGateDeps {
	return {
		readSignatures: () => {
			const signatures: string[] = [];
			for (const entry of ctx.sessionManager.getEntries()) {
				if (
					entry.type === "custom" &&
					"customType" in entry &&
					entry.customType === PROSE_BLOCK_ENTRY &&
					typeof (entry as { data?: unknown }).data === "string"
				) {
					signatures.push((entry as { data: string }).data);
				}
			}
			return signatures;
		},
		persistSignature: (signature) => {
			pi.appendEntry(PROSE_BLOCK_ENTRY, signature);
		},
	};
}

/** Run the prose gate over a body. Returns a block or undefined. */
export function runProseGate(
	deps: ProseGateDeps,
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
