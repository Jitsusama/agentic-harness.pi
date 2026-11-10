/**
 * A question pi asks before a conversation's screen exists, such as
 * "Trust project folder?", shown on that conversation's terminal the way
 * pi's CLI shows its startup selector: pi's ExtensionSelectorComponent in
 * a main-screen TUI of its own, which clears and stops once answered, so
 * the screen can take the same terminal. Unlike the CLI's, it sets no
 * theme, keybindings or terminal of the process: the host keeps one theme
 * for every screen, and the terminal is the conversation's alone. Both
 * classes are the host's pi's, handed in as it loaded them.
 */

import type { Component, Terminal, TUI } from "@earendil-works/pi-tui";
import type { ViewerTerminal } from "../../lib/core/viewer/terminal.ts";

/** A question being asked, and how the screens drive it. */
export interface StartupAsk {
	/** The label picked, or none when it was dismissed or cancelled. */
	readonly answer: Promise<string | undefined>;
	/** Draw it whole again, for a viewer that has just joined. */
	repaint(): void;
	/** Settle it unanswered, as the conversation closes. */
	cancel(): void;
}

/** Ask `title` on `terminal`, offering `labels`. */
export type StartupAsker = (
	terminal: ViewerTerminal,
	title: string,
	labels: readonly string[],
) => StartupAsk;

/** pi's selector, as its CLI builds it: a title, labels, and what to do on a pick or a dismissal. */
type SelectorClass = new (
	title: string,
	options: string[],
	onSelect: (option: string) => void,
	onCancel: () => void,
	opts: { tui: TUI },
) => Component;

/** pi-tui's main-screen TUI, over a terminal it is given. */
type MainScreenClass = new (terminal: Terminal) => TUI;

/**
 * Ask with the ExtensionSelectorComponent class the host's pi exports,
 * drawn in its pi-tui's TuiMainScreen, refusing anything else, with which
 * a hosted screen couldn't show pi's startup questions.
 */
export function hostedAskerOf(
	selector: unknown,
	mainScreen: unknown,
): StartupAsker {
	if (!isSelectorClass(selector))
		throw new Error("The host's pi exports no ExtensionSelectorComponent");
	if (!isMainScreenClass(mainScreen))
		throw new Error("The host's pi-tui exports no TuiMainScreen");
	return (terminal, title, labels) => {
		const ui = new mainScreen(terminal);
		let settle: (label: string | undefined) => void = () => undefined;
		const answer = new Promise<string | undefined>((done) => {
			settle = done;
		});
		let settled = false;
		const finish = (label: string | undefined) => {
			if (settled) return;
			settled = true;
			// Leave nothing behind for the screen that takes the terminal next.
			ui.clear();
			ui.renderNow(true);
			ui.stop();
			settle(label);
		};
		const component = new selector(
			title,
			[...labels],
			(label) => finish(label),
			() => finish(undefined),
			{ tui: ui },
		);
		ui.addChild(component);
		ui.setFocus(component);
		ui.start();
		return {
			answer,
			repaint: () => ui.requestRender(true),
			cancel: () => finish(undefined),
		};
	};
}

function isSelectorClass(value: unknown): value is SelectorClass {
	return typeof value === "function";
}

function isMainScreenClass(value: unknown): value is MainScreenClass {
	return typeof value === "function";
}
