/**
 * XDG-conformant path resolution for this pi package.
 *
 * Extensions and libraries in this package persist artifacts
 * to four kinds of locations: configuration, data, state and
 * cache. The XDG Base Directory Specification defines a home
 * for each, with an environment variable override and a
 * per-user default under `$HOME`.
 *
 *     kind     env var              default
 *     -----    ----------------     ----------------------
 *     config   XDG_CONFIG_HOME      ~/.config
 *     data     XDG_DATA_HOME        ~/.local/share
 *     state    XDG_STATE_HOME       ~/.local/state
 *     cache    XDG_CACHE_HOME       ~/.cache
 *
 * Every consumer in this package gets a path scoped under
 * `<xdg-root>/pi/agentic-harness.pi/<slug>/`. The `pi/`
 * segment is shared across all pi packages; the
 * `agentic-harness.pi/` segment scopes to this package; the
 * trailing `<slug>` segment isolates one consumer (an
 * extension or a library) from its siblings.
 *
 * Per the XDG spec, an empty environment variable is treated
 * identically to an unset one. Otherwise `join("", ...)`
 * would silently yield a cwd-relative path and write files
 * next to wherever the user happened to be standing.
 *
 * None of these helpers create the directory. Callers are
 * responsible for `mkdir -p` when they first write.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** Brand string used to scope paths to this pi package. */
const PACKAGE_DIR = "agentic-harness.pi";

/** Per-XDG-kind environment variables and default suffixes. */
const XDG_TABLE = {
	config: {
		envVar: "XDG_CONFIG_HOME",
		defaultSuffix: [".config"],
	},
	data: {
		envVar: "XDG_DATA_HOME",
		defaultSuffix: [".local", "share"],
	},
	state: {
		envVar: "XDG_STATE_HOME",
		defaultSuffix: [".local", "state"],
	},
	cache: {
		envVar: "XDG_CACHE_HOME",
		defaultSuffix: [".cache"],
	},
} as const;

type XdgKind = keyof typeof XDG_TABLE;

function xdgPath(kind: XdgKind, slug: string): string {
	const { envVar, defaultSuffix } = XDG_TABLE[kind];
	const override = process.env[envVar];
	const root =
		override && override.length > 0
			? override
			: join(homedir(), ...defaultSuffix);
	return join(root, "pi", PACKAGE_DIR, slug);
}

/**
 * Resolve the single package-level configuration file shared
 * by every extension in this package. Unlike {@link configDir}
 * this is not scoped to a consumer slug: it is one file whose
 * sections are keyed by slug. Honours `XDG_CONFIG_HOME`; falls
 * back to `~/.config`. The env and home are injectable so the
 * loader can be tested without mutating the process env.
 */
export function packageConfigPath(
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
): string {
	const override = env.XDG_CONFIG_HOME;
	const root =
		override && override.length > 0 ? override : join(home, ".config");
	return join(root, "pi", PACKAGE_DIR, "config.json");
}

/**
 * Resolve the on-disk configuration directory for one
 * consumer in this package. Use for user-editable
 * configuration files. Honours `XDG_CONFIG_HOME`; falls back
 * to `~/.config`.
 */
export function configDir(slug: string): string {
	return xdgPath("config", slug);
}

/**
 * Resolve the on-disk data directory for one consumer in
 * this package. Use for user-visible durable artifacts
 * (people registry, quest tree, content the user might
 * browse or back up). Honours `XDG_DATA_HOME`; falls back
 * to `~/.local/share`.
 */
export function dataDir(slug: string): string {
	return xdgPath("data", slug);
}

/**
 * Resolve the on-disk state directory for one consumer in
 * this package. Use for machine-owned state (workflow runs,
 * stream logs, fix worktrees, anything not meant for the
 * user to read directly). Honours `XDG_STATE_HOME`; falls
 * back to `~/.local/state`.
 */
export function stateDir(slug: string): string {
	return xdgPath("state", slug);
}

/**
 * Resolve the on-disk cache directory for one consumer in
 * this package. Use for derived data the consumer can
 * rebuild from authoritative sources. Honours
 * `XDG_CACHE_HOME`; falls back to `~/.cache`.
 */
export function cacheDir(slug: string): string {
	return xdgPath("cache", slug);
}
