/**
 * Public types for the terminal library.
 *
 * The library speaks one vocabulary for where a new shell appears,
 * defined by what a person sees rather than by any one terminal's
 * words:
 *
 * - a **window** is a new top-level window on the desktop;
 * - a **tab** is a new tab in an existing window;
 * - a **pane** is a split of the current tab, beside what is there.
 *
 * Each driver says how it renders each of these, or that it cannot,
 * and translates them into its own terminal's terms. Kitty's "window"
 * is a pane here, and tmux's "window" is a tab.
 *
 * A driver is pluggable: the built-ins live under `internal/terminal/
 * drivers/`, and any package can register its own with the same shape.
 */

/** Where the new shell should appear. */
export type TerminalLayout = "window" | "tab" | "pane";

/** Every layout, widest first. */
export const TERMINAL_LAYOUTS: readonly TerminalLayout[] = [
	"window",
	"tab",
	"pane",
];

/**
 * Which terminal a layout goes to when the session sits inside more
 * than one, such as pi in zellij in a kitty window. Innermost is the
 * one the person is looking at; outermost is the one holding it.
 */
export type TerminalNesting = "innermost" | "outermost";

/** The platforms the library supports, equally. */
export type TerminalPlatform = "linux" | "darwin";

/**
 * What kind of terminal a driver drives. An emulator draws windows on
 * the desktop; a multiplexer lives inside one and cannot make a
 * desktop window of its own. Inside both, the multiplexer is nearer.
 */
export type TerminalKind = "emulator" | "multiplexer";

/** A spawn request the driver fulfills. */
export interface TerminalRequest {
	/** Whether to open a window, a tab or a pane. */
	layout: TerminalLayout;
	/**
	 * Shell command to run. Drivers pass this through to
	 * the underlying spawn primitive; quoting is the
	 * driver's responsibility.
	 *
	 * Optional, because a caller may want the surface itself
	 * rather than a command in it: spawning a plain login
	 * shell and then typing into it is the only way to reach
	 * a shell that has run the user's own startup files.
	 */
	command?: string;
	/** Working directory for the new shell. */
	cwd?: string;
	/** Tab or window title, when the driver supports it. */
	title?: string;
	/**
	 * Extra environment variables. Drivers add these on
	 * top of the parent shell's environment.
	 */
	env?: Record<string, string>;
	/**
	 * A surface the new one belongs beside: a tab joins the window
	 * this names, a pane splits it. Absent, the driver uses the
	 * surface it is attached to.
	 */
	near?: TerminalSessionHandle;
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
	 * active terminal. Reads environment variables only, since it runs
	 * when every session starts.
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

/**
 * Optional capability for typing into a surface that already exists.
 *
 * Separate from spawning because it is the only way to reach a shell
 * that has run the user's own startup files. Handing a command to the
 * spawn primitive runs it under a non-interactive shell, which skips
 * the hooks that set a project's environment up, so a command that
 * works when typed fails when spawned. Recovering by hand after a
 * crash meant spawning bare shells and typing the resume lines in,
 * and a driver that can do that is a driver that can do the recovery
 * itself.
 */
export interface TerminalTypeCapability {
	/**
	 * Type text into an existing surface, as though the user had. A
	 * trailing newline submits it; without one the text is left on the
	 * command line for the user to read and press enter on.
	 */
	typeInto(handle: TerminalSessionHandle, text: string): Promise<void>;
}

/**
 * The terminal a session is inside, as its environment or its process
 * ancestry shows it. `handle` is present when the driver can name the
 * surface; `reachable` says whether the control channel that would let
 * the driver act on it is there at all, read from the environment
 * without contacting it.
 */
export interface TerminalSighting {
	/** The driver that recognised the terminal. */
	driverId: string;
	/** The surface the session sits in, when the driver can name it. */
	handle?: TerminalSessionHandle;
	/** Whether the environment carries a control channel to act through. */
	reachable: boolean;
	/**
	 * Where the sighting came from: the terminal's own variables, the
	 * process ancestry, or a driver that predates sightings and said it
	 * was available.
	 */
	source: "environment" | "ancestry" | "driver";
}

/**
 * Optional capability for starting a new instance of the terminal
 * that is under the driver's control from its first window, so the
 * window it opens can be typed into and probed like an attached one.
 * Kitty does this by starting with a socket of the driver's choosing.
 */
export interface TerminalLaunchCapability {
	/**
	 * Start a new instance showing one window in `request.cwd`, running
	 * the user's login shell, and return a handle to that window. The
	 * instance belongs to the person: it ends when they close it.
	 */
	launch(
		request: TerminalRequest,
		context: TerminalLaunchContext,
	): Promise<TerminalSessionHandle>;
}

/** What a driver needs to know to launch a controlled instance. */
export interface TerminalLaunchContext {
	/** The absolute path of the terminal's binary. */
	binary: string;
	/** The platform being launched on. */
	platform: TerminalPlatform;
	/** The environment the new instance starts with. */
	env: Readonly<Record<string, string | undefined>>;
}

/** A pluggable terminal driver. */
export interface TerminalDriver {
	/** Identifier (e.g. "wezterm", "tmux"). */
	id: string;
	/**
	 * Whether this drives an emulator or a multiplexer. Absent reads as
	 * an emulator, which is what a driver written before the field
	 * existed most likely is.
	 */
	kind?: TerminalKind;
	/**
	 * The binary the driver runs, by name. Discovery resolves it to an
	 * absolute path, and a driver whose binary does not resolve is not
	 * offered. Absent for a driver that runs nothing, like the fallback.
	 */
	binary?: string;
	/**
	 * The program names the terminal runs as, normalised (basename,
	 * lowercased, without a Nix `-wrapped` suffix or a macOS `.app`
	 * path), so process ancestry can confirm the session really sits in
	 * it and say how deep. A driver without them is taken at its
	 * environment's word.
	 */
	programs?: readonly string[];
	/**
	 * How the driver renders each layout, in its own terminal's words,
	 * for listings and refusals. A layout missing here is one the driver
	 * cannot render. Absent means every layout, which keeps a driver
	 * written before the vocabulary working as it did.
	 */
	layouts?: Readonly<Partial<Record<TerminalLayout, string>>>;
	/**
	 * Quick probe: is this driver usable in the current
	 * environment? Implementations check for the binary on
	 * PATH and any required runtime context.
	 */
	available(): Promise<boolean> | boolean;
	/**
	 * The terminal the environment says this session is inside, or
	 * undefined when it says nothing about this driver. Reads
	 * environment variables only.
	 */
	sight?(
		env: Readonly<Record<string, string | undefined>>,
	): TerminalSighting | undefined;
	/**
	 * Dispatch the spawn. Resolves when the spawn command
	 * has been sent; the actual lifetime of the spawned
	 * process is the driver's concern.
	 *
	 * Returns a handle to the new surface when the driver can name
	 * one, so a caller that spawned a bare shell can then type into
	 * it. A driver whose spawn primitive says nothing about what it
	 * created returns undefined, which is honest rather than a
	 * guess.
	 */
	spawn(request: TerminalRequest): Promise<TerminalSessionHandle | undefined>;
}

/** Whether a driver can render a layout. */
export function rendersLayout(
	driver: Pick<TerminalDriver, "layouts">,
	layout: TerminalLayout,
): boolean {
	return driver.layouts === undefined || layout in driver.layouts;
}
