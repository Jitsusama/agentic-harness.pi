/**
 * The chord that submits a panel holding several answers at once: a tabbed
 * gate, a toggle list, a workspace.
 *
 * It was Ctrl+Enter alone, and a terminal can only tell Ctrl+Enter from
 * Enter when it speaks the kitty protocol or modifyOtherKeys. tmux as it
 * comes and macOS Terminal speak neither and send Enter for both, so there
 * a gate that waits to be submitted could be answered item by item and
 * then only ever cancelled. Ctrl+S reaches pi as its own byte from every
 * terminal, and pi's own selectors already save with it, so both are
 * accepted everywhere. The footer names the one the terminal is known to
 * send: Ctrl+Enter only once the kitty protocol has answered, since pi asks
 * for modifyOtherKeys without learning whether it was granted.
 */

import { isKittyProtocolActive, Key, matchesKey } from "@earendil-works/pi-tui";

/** Whether `data` submits: Ctrl+Enter, or Ctrl+S from any terminal. */
export function isSubmitKey(data: string): boolean {
	return matchesKey(data, Key.ctrl("enter")) || matchesKey(data, Key.ctrl("s"));
}

/** The submit chord as a footer says it, for the terminal pi is in now. */
export function submitKeyLabel(): string {
	return isKittyProtocolActive() ? "Ctrl+Enter" : "Ctrl+S";
}
