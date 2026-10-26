/**
 * Built-in terminal drivers, in the order discovery tries them when
 * nothing else decides: the emulators that can launch a window under
 * their own control first, then the multiplexers, then the fallback,
 * which prints and always works.
 */

import type { TerminalDriver } from "../../terminal/types.ts";
import { fallback } from "./drivers/fallback.ts";
import { kitty } from "./drivers/kitty.ts";
import { tmux } from "./drivers/tmux.ts";
import { wezterm } from "./drivers/wezterm.ts";
import { zellij } from "./drivers/zellij.ts";

export const BUILTIN_TERMINAL_DRIVERS: readonly TerminalDriver[] = [
	kitty,
	wezterm,
	zellij,
	tmux,
	fallback,
];
