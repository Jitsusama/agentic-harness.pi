/**
 * Persistence and the live scoreboard. persist and restore
 * carry the loop across a `/reload` by round-tripping through
 * session history; they touch no UI so they stay unit-testable.
 * updateScoreboard is the one live surface: it paints the
 * status line and the widget through the running theme.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getLastEntry } from "../../lib/internal/state.js";
import { initialState, type Phase } from "./machine.js";
import { renderStatus, renderWidget } from "./render.js";
import type { TddState } from "./state.js";

/** Width fallback when the terminal width is unknown. */
const DEFAULT_WIDTH = 80;

/** The phases a persisted entry may legitimately carry. */
const PHASES: Phase[] = ["idle", "plan", "write", "red", "green", "refactor"];

/** The session-history shape of a persisted loop. */
interface PersistedLoop {
	phase?: Phase;
	assertionFailure?: boolean;
	behaviour?: string | null;
	iteration?: number;
}

/** Save the current loop to session history. */
export function persist(state: TddState, pi: ExtensionAPI): void {
	const loop = state.loop;
	pi.appendEntry("tdd-workflow", {
		phase: loop.phase,
		assertionFailure: loop.assertionFailure,
		behaviour: loop.behaviour,
		iteration: loop.iteration,
	});
}

/**
 * Whether a persisted entry is a loop this version understands.
 * A legacy gated entry carries an `enabled` flag; a current entry
 * carries a known phase. A current entry missing a later-added
 * field is still ours, so it is rehydrated rather than dropped.
 */
function isLoopEntry(saved: PersistedLoop): boolean {
	if ("enabled" in saved) {
		return false;
	}
	return (
		typeof saved.phase === "string" &&
		(PHASES as string[]).includes(saved.phase)
	);
}

/** Rehydrate the loop from session history, or start fresh. */
export function restore(state: TddState, ctx: ExtensionContext): void {
	const saved = getLastEntry<PersistedLoop>(ctx, "tdd-workflow");
	if (!saved || !isLoopEntry(saved)) {
		state.loop = initialState();
		return;
	}
	state.loop = {
		phase: saved.phase ?? "idle",
		assertionFailure: saved.assertionFailure ?? false,
		behaviour: saved.behaviour ?? null,
		iteration: saved.iteration ?? 0,
	};
}

/** Repaint the status line and the widget from the current loop. */
export function updateScoreboard(state: TddState, ctx: ExtensionContext): void {
	ctx.ui.setStatus("tdd-workflow", renderStatus(state.loop, ctx.ui.theme));
	const width = process.stdout.columns || DEFAULT_WIDTH;
	ctx.ui.setWidget(
		"tdd-loop",
		state.loop.phase !== "idle"
			? renderWidget(state.loop, ctx.ui.theme, width)
			: undefined,
	);
}
