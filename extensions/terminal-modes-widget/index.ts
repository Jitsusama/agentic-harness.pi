/**
 * Terminal Modes Widget Extension
 *
 * Says pi's terminal modes again whenever its terminal changes size, and
 * draws the whole screen afresh. A held session is shown by a terminal
 * that joins it later and was never told the modes pi entered as it
 * started: after the 30 October restore, every window Joel used lacked
 * the mouse, bracketed paste and the alternate screen, and one lost its
 * editor's bottom rule. A joining terminal changes the size pi reads, so
 * a resize is when to say them. Entering a mode pi is already in changes
 * nothing (lib/ui/terminal-modes.ts), and the holder, which replays the
 * modes it saw itself, agrees (4UHC5Q, 3f071854).
 *
 * It holds no rows of its own: the widget is how an extension is handed
 * pi's TUI, and it draws nothing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { drawsToTerminal } from "../../lib/ui/dock.ts";
import { enterModes, modesOf } from "../../lib/ui/terminal-modes.ts";

const KEY = "terminal-modes";

export default function terminalModesWidget(pi: ExtensionAPI) {
	let tui: TUI | undefined;
	const sayAgain = () => {
		if (!tui) return;
		tui.terminal.write(enterModes(modesOf(tui)));
		tui.requestRender(true);
	};
	const stop = () => {
		process.stdout.off("resize", sayAgain);
		tui = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		stop();
		if (!drawsToTerminal(ctx)) return;
		ctx.ui.setWidget(KEY, (given) => {
			tui = given;
			return { render: () => [], invalidate: () => {} };
		});
		process.stdout.on("resize", sayAgain);
	});

	pi.on("session_shutdown", async () => stop());
}
