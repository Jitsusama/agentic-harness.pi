/**
 * Public types for the terminal library.
 *
 * A `TerminalDriver` knows how to spawn a new shell in a
 * tab, a pane or a window of the user's terminal emulator
 * or multiplexer. The library is pluggable: built-ins
 * (wezterm, tmux, fallback) live in `lib/internal/terminal/
 * drivers/`; consumers register their own with the same
 * shape.
 */

/** Where the new shell should appear. */
export type TerminalLayout = "tab" | "pane" | "window";

/** A spawn request the driver fulfills. */
export interface TerminalRequest {
	/** Whether to open in a tab, a pane or a new window. */
	layout: TerminalLayout;
	/**
	 * Shell command to run. Drivers pass this through to
	 * the underlying spawn primitive; quoting is the
	 * driver's responsibility.
	 */
	command: string;
	/** Working directory for the new shell. */
	cwd?: string;
	/** Tab or window title, when the driver supports it. */
	title?: string;
	/**
	 * Extra environment variables. Drivers add these on
	 * top of the parent shell's environment.
	 */
	env?: Record<string, string>;
}

/** A pluggable terminal driver. */
export interface TerminalDriver {
	/** Identifier (e.g. "wezterm", "tmux"). */
	id: string;
	/**
	 * Quick probe: is this driver usable in the current
	 * environment? Implementations check for the binary on
	 * PATH and any required runtime context.
	 */
	available(): Promise<boolean> | boolean;
	/**
	 * Dispatch the spawn. Resolves when the spawn command
	 * has been sent; the actual lifetime of the spawned
	 * process is the driver's concern.
	 */
	spawn(request: TerminalRequest): Promise<void>;
}
