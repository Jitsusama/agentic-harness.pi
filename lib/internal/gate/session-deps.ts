/**
 * Session-backed implementation of the gate signature store. The
 * prose, section and Slack gates all record the violation
 * signatures they have blocked this session and read them back,
 * so the loop breaker in lib/gate can relent on a repeat.
 * Signatures are namespaced by violation kind (`emdash:`,
 * `spelling:`, `section:`, `slack-table:` and so on), so every
 * gate can share one store without colliding.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { GateDeps } from "../../gate/index.js";

/** The custom session-entry type that holds a block signature. */
const GATE_BLOCK_ENTRY = "gate-block-signature";

/**
 * Build session-backed gate deps. Signatures are read from the
 * session entries and persisted as custom entries, so the relent
 * logic survives across gate fires within a session.
 */
export function sessionGateDeps(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): GateDeps {
	return {
		readSignatures: () => {
			const signatures: string[] = [];
			for (const entry of ctx.sessionManager.getEntries()) {
				if (
					entry.type === "custom" &&
					"customType" in entry &&
					entry.customType === GATE_BLOCK_ENTRY &&
					typeof (entry as { data?: unknown }).data === "string"
				) {
					signatures.push((entry as { data: string }).data);
				}
			}
			return signatures;
		},
		persistSignature: (signature) => {
			pi.appendEntry(GATE_BLOCK_ENTRY, signature);
		},
	};
}
