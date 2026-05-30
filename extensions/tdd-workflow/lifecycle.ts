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

/** The session-history shape of a persisted loop. */
interface PersistedLoop {
	phase?: Phase;
	redVerified?: boolean;
	behaviour?: string | null;
	loop?: number;
	engaged?: boolean;
}

/** Save the current loop to session history. */
export function persist(state: TddState, pi: ExtensionAPI): void {
	const loop = state.loop;
	pi.appendEntry("tdd-workflow", {
		phase: loop.phase,
		redVerified: loop.redVerified,
		behaviour: loop.behaviour,
		loop: loop.loop,
		engaged: loop.engaged,
	});
}

/** Rehydrate the loop from session history, or start fresh. */
export function restore(state: TddState, ctx: ExtensionContext): void {
	const saved = getLastEntry<PersistedLoop>(ctx, "tdd-workflow");
	if (!saved || typeof saved.engaged !== "boolean") {
		state.loop = initialState();
		return;
	}
	state.loop = {
		phase: saved.phase ?? "idle",
		redVerified: saved.redVerified ?? false,
		behaviour: saved.behaviour ?? null,
		loop: saved.loop ?? 0,
		engaged: saved.engaged,
	};
}

/** Repaint the status line and the widget from the current loop. */
export function updateScoreboard(state: TddState, ctx: ExtensionContext): void {
	ctx.ui.setStatus("tdd-workflow", renderStatus(state.loop, ctx.ui.theme));
	const width = process.stdout.columns || DEFAULT_WIDTH;
	ctx.ui.setWidget(
		"tdd-loop",
		state.loop.behaviour
			? renderWidget(state.loop, ctx.ui.theme, width)
			: undefined,
	);
}
