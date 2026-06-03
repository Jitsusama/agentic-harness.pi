/**
 * Built-in terminal drivers, in the order
 * `resolveDriver` tries them when no preferred driver is
 * set. The fallback driver lands last so a real driver
 * wins when one is present.
 */

import type { TerminalDriver } from "../../terminal/types.js";
import { fallback } from "./drivers/fallback.js";
import { tmux } from "./drivers/tmux.js";
import { wezterm } from "./drivers/wezterm.js";

export const BUILTIN_TERMINAL_DRIVERS: readonly TerminalDriver[] = [
	wezterm,
	tmux,
	fallback,
];
