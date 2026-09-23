/**
 * Built-in terminal drivers, in the order
 * `resolveDriver` tries them when no preferred driver is
 * set. The fallback driver lands last so a real driver
 * wins when one is present.
 */

import type { TerminalDriver } from "../../terminal/types.ts";
import { fallback } from "./drivers/fallback.ts";
import { tmux } from "./drivers/tmux.ts";
import { wezterm } from "./drivers/wezterm.ts";

export const BUILTIN_TERMINAL_DRIVERS: readonly TerminalDriver[] = [
	wezterm,
	tmux,
	fallback,
];
