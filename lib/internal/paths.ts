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
 * A few consumers keep what belongs to a realm rather than to the
 * machine: the quest store and its records, the mesh, and the steer
 * inboxes. A session in a realm other than its machine's home realm
 * finds theirs under `<xdg-root>/pi/agentic-harness.pi/realms/<name>/`
 * (see realm.ts); everything else is the machine's, whichever realm
 * asks.
 *
 * None of these helpers create the directory. Callers are
 * responsible for `mkdir -p` when they first write.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { realmSegments } from "./realm.ts";

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

/**
 * The consumers whose folders are the realm's own: what one realm's
 * sessions say to each other, the quests they work and the person's
 * words to them. The machine queue, trees, reviews and caches stay the
 * machine's, since both realms share its cores and disk.
 */
const REALM_SLUGS: ReadonlySet<string> = new Set([
	"quest-workflow",
	"mesh-workflow",
	"steer",
]);

function xdgRoot(kind: XdgKind): string {
	const { envVar, defaultSuffix } = XDG_TABLE[kind];
	const override = process.env[envVar];
	return override && override.length > 0
		? override
		: join(homedir(), ...defaultSuffix);
}

function xdgPath(kind: XdgKind, slug: string): string {
	const realm = REALM_SLUGS.has(slug) ? realmSegments() : [];
	return join(xdgRoot(kind), "pi", PACKAGE_DIR, ...realm, slug);
}

/**
 * A realm's own folder for `slug` in every realm this machine keeps one
 * for, the home realm's first. For what the machine has once and any
 * realm's sessions may hold, as a work tree is: counting only its own
 * realm's quests and sessions, a sweep in one realm would take another
 * realm's trees as nobody's.
 */
export function everyRealmsDir(kind: "data" | "state", slug: string): string[] {
	const root = join(xdgRoot(kind), "pi", PACKAGE_DIR);
	let others: string[] = [];
	try {
		others = readdirSync(join(root, "realms"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(root, "realms", entry.name, slug))
			.sort();
	} catch {
		// No other realm has kept anything here.
	}
	return [join(root, slug), ...others];
}

let darwinTemporary: string | undefined;

/**
 * The login's own runtime folder, for sockets and queues that last only
 * as long as the login: `XDG_RUNTIME_DIR`, or on a Mac, which has none,
 * the account's own temporary folder, which a session's `TMPDIR` need
 * not name since a quest moves that. Nothing where neither is known.
 */
export function runtimeDir(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR;
	if (platform() !== "darwin") return undefined;
	if (darwinTemporary === undefined) {
		try {
			darwinTemporary = execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], {
				encoding: "utf8",
			}).trim();
		} catch {
			// The system won't say, so there is no runtime folder to name.
			darwinTemporary = "";
		}
	}
	return darwinTemporary || undefined;
}

/**
 * Resolve the pi session store directory, where pi writes one
 * JSONL log per session under a cwd-encoded subdirectory. Pi
 * keeps this at `~/.pi/agent/sessions`; the home is injectable
 * for testing.
 */
export function sessionsDir(home = homedir()): string {
	return join(home, ".pi", "agent", "sessions");
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
