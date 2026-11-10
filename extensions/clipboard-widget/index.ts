/**
 * Clipboard Widget Extension
 *
 * Ctrl+V in pi's editor under Wayland, read through a small shell the
 * session forks once at its start, so a paste never waits on the
 * session forking. pi's own paste forks the whole session twice per
 * keypress, and an old session under load took seconds to paste.
 *
 * It takes the key only while pi's editor holds the keyboard, and
 * leaves it to pi everywhere else, on every other platform and without
 * a Wayland display. When the shell can't answer, the paste reads the
 * way pi does, from the session, and the shell is started again after.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	isKeyRelease,
	Key,
	matchesKey,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	type Helper,
	type Read,
	readDirectly,
	startHelper,
} from "../../lib/internal/clipboard/helper.ts";
import {
	insertPasted,
	type PasteTarget,
	pastesThroughWayland,
	readPaste,
} from "../../lib/internal/clipboard/paste.ts";
import { focusedIn, isEditor } from "../../lib/ui/pi-layout.ts";

const WIDGET = "clipboard-widget";

/** A widget that draws nothing, there only to be handed pi's TUI. */
const UNSEEN: Component = { render: () => [], invalidate: () => {} };

export default function clipboardWidget(pi: ExtensionAPI): void {
	if (!pastesThroughWayland(process.platform, process.env)) return;
	let helper: Helper | undefined;
	let tui: TUI | undefined;
	let unlisten: (() => void) | undefined;

	const read: Read = async (argv, timeoutMs) => {
		const said = helper?.alive()
			? await helper.read(argv, timeoutMs)
			: undefined;
		return said ?? readDirectly(argv, timeoutMs);
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!helper?.alive()) helper = startHelper();
		ctx.ui.setWidget(
			WIDGET,
			(given: TUI) => {
				tui = given;
				return UNSEEN;
			},
			{ placement: "belowEditor" },
		);
		unlisten?.();
		unlisten = ctx.ui.onTerminalInput((data) => {
			if (isKeyRelease(data) || !matchesKey(data, Key.ctrl("v"))) {
				return undefined;
			}
			const target = tui ? focusedIn(tui) : null;
			if (!target || !isEditor(target) || !insertsText(target)) {
				return undefined;
			}
			void paste(target, ctx);
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		unlisten?.();
		unlisten = undefined;
		helper?.stop();
		helper = undefined;
	});

	async function paste(target: PasteTarget, ctx: ExtensionContext) {
		try {
			await insertPasted(target, await readPaste(read));
			tui?.requestRender();
		} catch (error) {
			const why = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Failed to paste from clipboard: ${why}`, "error");
		} finally {
			if (helper && !helper.alive()) helper = startHelper();
		}
	}
}

function insertsText(
	component: Component,
): component is Component & PasteTarget {
	return typeof Reflect.get(component, "insertTextAtCursor") === "function";
}
