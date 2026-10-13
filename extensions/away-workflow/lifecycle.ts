/**
 * Keeping an absence across a restart, and showing it in the footer.
 *
 * Every change is written as a session entry holding the whole
 * snapshot, so the latest entry on the branch is the state to restore.
 * A restart while away comes back away, with what was held and decided,
 * so the first thing the person types still shows them what waited.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type AwaySnapshot,
	type Decision,
	type HeldCall,
	restore,
} from "../../lib/internal/away/state.ts";
import { footerMark, type MarkTheme } from "../../lib/ui/footer-mark.ts";

/** The custom entry type an absence is stored under. */
export const AWAY_ENTRY = "away-state";

/** Footer key. */
export const STATUS_KEY = "away";

function isHeldCall(value: unknown): value is HeldCall {
	if (typeof value !== "object" || value === null) return false;
	return (
		"id" in value &&
		typeof value.id === "number" &&
		"guard" in value &&
		typeof value.guard === "string" &&
		"title" in value &&
		typeof value.title === "string" &&
		"fingerprint" in value &&
		typeof value.fingerprint === "string" &&
		"at" in value &&
		typeof value.at === "string"
	);
}

function isDecision(value: unknown): value is Decision {
	if (typeof value !== "object" || value === null) return false;
	return (
		"question" in value &&
		typeof value.question === "string" &&
		"answer" in value &&
		typeof value.answer === "string" &&
		"by" in value &&
		(value.by === "recommendation" || value.by === "model")
	);
}

/** Whether a stored entry's data reads as a snapshot. */
export function isAwaySnapshot(value: unknown): value is AwaySnapshot {
	if (typeof value !== "object" || value === null) return false;
	if (!("held" in value) || !Array.isArray(value.held)) return false;
	if (!("decided" in value) || !Array.isArray(value.decided)) return false;
	if ("since" in value && typeof value.since !== "string") return false;
	if ("goal" in value && typeof value.goal !== "string") return false;
	return value.held.every(isHeldCall) && value.decided.every(isDecision);
}

/** The latest snapshot on the branch, if any. */
export function savedSnapshotOf(
	entries: readonly unknown[],
): AwaySnapshot | undefined {
	for (let at = entries.length - 1; at >= 0; at--) {
		const entry = entries[at];
		if (
			typeof entry === "object" &&
			entry !== null &&
			"type" in entry &&
			entry.type === "custom" &&
			"customType" in entry &&
			entry.customType === AWAY_ENTRY &&
			"data" in entry
		) {
			// The latest entry is the state, readable or not: falling back
			// to an older one could resurrect an absence that had ended.
			return isAwaySnapshot(entry.data) ? entry.data : undefined;
		}
	}
	return undefined;
}

/** Put back the absence this session was in, if it was in one. */
export function restoreAway(ctx: ExtensionContext): void {
	const saved = savedSnapshotOf(ctx.sessionManager.getBranch());
	restore(saved ?? { held: [], decided: [] });
}

/** Write the absence down. */
export function saveAway(pi: ExtensionAPI, snapshot: AwaySnapshot): void {
	pi.appendEntry<AwaySnapshot>(AWAY_ENTRY, snapshot);
}

/**
 * The footer mark for an absence, or undefined when present.
 *
 * A moon while the person is away, since a mode always shows that it
 * is on. It stays muted while the session works on alone and takes the
 * warning colour once something is held for their return, because
 * that is the moment it wants them; the quiet number beside it is how
 * many calls are held. What they are is listed when the person comes
 * back, which is the only time they can be acted on.
 */
export function statusText(
	snapshot: AwaySnapshot,
	theme: MarkTheme,
): string | undefined {
	if (snapshot.since === undefined) return undefined;
	const held = snapshot.held.length;
	if (held === 0) return footerMark("away", "muted", theme);
	return `${footerMark("away", "warning", theme)} ${theme.fg("dim", String(held))}`;
}
