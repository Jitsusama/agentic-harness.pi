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

/**
 * A stable, probeable reference to a terminal surface a pi session
 * was observed in. Recorded on the session so a later reader can ask
 * the same driver whether that surface still exists. `scope` is the
 * mux socket and host fingerprint that makes `value` (a pane id)
 * meaningful across terminal instances and hosts.
 */
export interface TerminalSessionHandle {
	/** Id of the driver that issued the handle. */
	driverId: string;
	/** Driver-specific kind, e.g. "wezterm-pane". */
	kind: string;
	/** Host the surface lives on; a foreign host is unprobeable. */
	hostId: string;
	/** Mux socket / server fingerprint that scopes `value`. */
	scope?: string;
	/** The surface id itself, e.g. a wezterm pane id. */
	value: string;
}

/**
 * A terminal probe outcome. Present and absent are only meaningful
 * when the probe could actually observe the surface; anything else
 * (unreachable mux, timeout, foreign scope, unsupported driver) is
 * unknown, never a false absent.
 */
export type TerminalProbe = "present" | "absent" | "unknown";

/**
 * Optional liveness capability a terminal driver may implement in
 * addition to spawning. Resolved by the recorded driver id, never by
 * the reader's current terminal, and probed in one batch per scope
 * rather than once per handle.
 */
export interface TerminalLivenessCapability {
	/**
	 * The handle for the surface the current pi process runs in, read
	 * from the environment, or undefined when this driver is not the
	 * active terminal.
	 */
	identifyCurrent(): TerminalSessionHandle | undefined;
	/**
	 * Probe a batch of handles, returning a map keyed by
	 * {@link terminalHandleKey}. One transport call per scope. The key
	 * is host, scope and value together, not the bare pane value, since
	 * a pane id is only unique within one terminal instance.
	 */
	probe(
		handles: readonly TerminalSessionHandle[],
		signal?: AbortSignal,
	): Promise<ReadonlyMap<string, TerminalProbe>>;
}

/**
 * The stable key a probe result is keyed by. A pane value is only
 * unique within one terminal instance, so two instances can both hold
 * pane "0"; keying by host, scope and value keeps their probe results
 * from colliding when a batch spans instances.
 */
export function terminalHandleKey(handle: TerminalSessionHandle): string {
	return `${handle.driverId}\u0000${handle.hostId}\u0000${handle.scope ?? ""}\u0000${handle.value}`;
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
