/**
 * Where a session stands.
 *
 * Everything a session accumulates is invisible until asked
 * for: what it is pretending to be, what it has intercepted,
 * how much it has recorded, and how far each buffer has been
 * read. Coming back to a session after doing something else and
 * having to guess at any of that is how a reading gets
 * misattributed to the wrong page.
 */

import type { DialogPolicy, LifecycleEvent } from "../telemetry/index.js";
import type { Divergence, EmulationState } from "./emulation.js";
import type { NetworkRule, ThrottleConditions } from "./shaping.js";

/** Everything worth knowing about a session at a glance. */
export interface SessionStatus {
	readonly name: string;
	readonly url: string;
	readonly title: string;
	readonly emulation: EmulationState;
	/** Where the page disagrees with what is being emulated. */
	readonly gaps?: readonly Divergence[];
	readonly rules: readonly NetworkRule[];
	readonly throttle?: ThrottleConditions;
	readonly dialogPolicy: DialogPolicy;
	readonly dialogsSeen: number;
	readonly logs: { readonly count: number; readonly cursor: number };
	readonly announcements: { readonly count: number; readonly cursor: number };
	readonly requests: { readonly count: number; readonly failed: number };
	readonly history: readonly LifecycleEvent[];
	readonly artifacts: readonly string[];
	/**
	 * A trace being recorded anywhere in the browser.
	 *
	 * Reported by every session rather than only the one that
	 * started it, because tracing instruments every page and a
	 * reader wondering why theirs is slow should find the reason
	 * here instead of hunting for it.
	 */
	readonly recording?: string;
}

/** How many recent navigations are worth recalling. */
const RECENT_HISTORY = 5;

/** The session, in one reading. */
export function renderStatus(status: SessionStatus): string {
	const lines = [
		`Session '${status.name}'`,
		`  at ${status.url || "nowhere yet"}`,
		...(status.title ? [`  titled ${status.title}`] : []),
		"",
		`  ${status.logs.count} log entries, cursor ${status.logs.cursor}`,
		`  ${status.requests.count} requests${
			status.requests.failed > 0 ? `, ${status.requests.failed} failed` : ""
		}`,
		`  ${status.announcements.count} announcements, cursor ` +
			`${status.announcements.cursor}`,
	];

	const pretending = describeEmulation(status.emulation);
	if (pretending) lines.push("", `  pretending: ${pretending}`);
	// Only ever claimed with the page's agreement.
	//
	// An override sent to a renderer that a navigation then replaced
	// goes nowhere, and Chrome gives no signal when that happens. It
	// is now applied again on arrival and checked against the page,
	// which fixes nearly every case, but a browser that loses it
	// anyway must not be described as a phone: reading "pretending:
	// iPhone 15 Pro" while the page cannot detect a touch screen is
	// how a tester concludes a site is broken on mobile when it is
	// the tool that is wrong. So the claim carries the page's answer
	// with it, and the reader is told which part did not take.
	for (const gap of status.gaps ?? []) {
		lines.push(`  not landed: ${gap.what} is ${gap.observed}`);
	}

	if (status.throttle?.offline) {
		lines.push("  network: offline");
	} else if (status.throttle && status.throttle.latency > 0) {
		lines.push(`  network: throttled, ${status.throttle.latency}ms latency`);
	}
	if (status.recording) lines.push(`  ${status.recording}`);
	if (status.rules.length > 0) {
		lines.push(
			`  intercepting: ${status.rules
				.map((rule) => `${rule.action} ${rule.pattern}`)
				.join(", ")}`,
		);
	}

	lines.push(
		`  dialogs: ${status.dialogPolicy.accept ? "accepted" : "dismissed"}` +
			`${status.dialogsSeen > 0 ? `, ${status.dialogsSeen} so far` : ""}`,
	);

	// A crash divides the session in two, so it is worth seeing
	// without having to ask for the history separately.
	const crashes = status.history.filter(
		(event) => event.kind === "crashed",
	).length;
	if (crashes > 0) {
		lines.push(
			`  the tab has crashed ${crashes === 1 ? "once" : `${crashes} times`}` +
				" and been replaced",
		);
	}

	const recent = status.history.slice(-RECENT_HISTORY);
	if (recent.length > 0) {
		lines.push("", "  recently:");
		for (const event of recent) {
			lines.push(`    ${event.kind}${event.url ? ` ${event.url}` : ""}`);
		}
	}

	if (status.artifacts.length > 0) {
		lines.push("", "  written to disk:");
		for (const path of status.artifacts) lines.push(`    ${path}`);
	}

	return lines.join("\n");
}

/** What the session is pretending, in one phrase. */
function describeEmulation(state: EmulationState): string {
	const notes: string[] = [];
	if (state.device) notes.push(state.device);
	else if (state.viewport) {
		notes.push(`${state.viewport.width} by ${state.viewport.height}`);
	}
	if (state.colorScheme) notes.push(`${state.colorScheme} mode`);
	if (state.reducedMotion) notes.push("reduced motion");
	if (state.contrast && state.contrast !== "no-preference") {
		notes.push(`${state.contrast} contrast`);
	}
	if (state.forcedColors) notes.push("forced colours");
	if (state.vision && state.vision !== "none") notes.push(state.vision);
	if (state.media === "print") notes.push("print layout");
	if (state.touch) notes.push("touch");
	if (state.timezone) notes.push(state.timezone);
	if (state.locale) notes.push(state.locale);
	if (state.cpuThrottle && state.cpuThrottle > 1) {
		notes.push(`cpu ${state.cpuThrottle}x slower`);
	}
	return notes.join(", ");
}
