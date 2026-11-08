/**
 * Working Spinner Widget Extension
 *
 * Keeps pi's working spinner turning only in the window the person is
 * in, and shows a still mark in the others. pi turns it every 80 ms
 * while a session works, and each turn is a write that wakes the
 * terminal and has the compositor redraw. On 7 November kitty switched
 * context about 990 times a second at 19% of a core, and niri spent 35
 * to 49% of one refreshing its windows (M4RL61); on 8 November 20
 * sessions were at work at once, about 250 frames a second. A spinner
 * nobody is looking at says nothing a still mark doesn't.
 *
 * Focus is read from the terminal's focus reports, which pi asks for in
 * fullscreen, and from keys, which only the focused window gets. Until
 * either arrives the mark is still: a window spawned beside the person's
 * never gains focus, so waiting to be told it lost focus would leave it
 * turning for good.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { drawsToTerminal } from "../../lib/ui/dock.ts";
import { stillWhereUnfocused } from "../../lib/ui/working-spinner.ts";

export default function workingSpinnerWidget(pi: ExtensionAPI) {
	let unlisten: (() => void) | undefined;
	const stop = () => {
		unlisten?.();
		unlisten = undefined;
	};

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		stop();
		if (!drawsToTerminal(ctx)) return;
		unlisten = stillWhereUnfocused(ctx.ui);
	});

	pi.on("session_shutdown", async () => stop());
}
