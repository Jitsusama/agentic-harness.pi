/**
 * A host's compile cache: node keeps what it compiled of the host's
 * modules, pi's and the harness's, so a start after the first reads
 * them back rather than compiling them again. It is enabled before the
 * host's code loads, in a folder of the realm, kind and install, since
 * an install's files never change and another install's never apply;
 * starting, a host removes its own earlier installs' folders and keeps
 * every other host's. The folders lie in the login's runtime folder
 * where it can be had, and in pi's state else (compile-cache-place.ts).
 * A cache that can't be had is said, and the host starts without it.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { constants, enableCompileCache } from "node:module";
import { isAbsolute, join } from "node:path";
import { compileFolderOf } from "../../lib/internal/fence/compile-cache-place.ts";
import { stateDir } from "../../lib/internal/paths.ts";
import { CHILD_FLAG, hostKey, hostKeyParts, hostRealm } from "./address.ts";

/** How many hex characters of the install's hash name its folder. */
const INSTALL_KEY_CHARS = 16;

/** What node answers when asked to enable its compile cache. */
interface Enabled {
	readonly status: number;
	readonly message?: string;
}

/** What a host starts its compile cache from. */
export interface CompileCacheOptions {
	/** The host's command line, naming its kind. */
	readonly argv: readonly string[];
	/** Its environment, naming its realm and its pi in PI_PACKAGE_DIR. */
	readonly env: Readonly<Record<string, string | undefined>>;
	/** The harness the host runs from, reached through any link. */
	readonly harnessRoot: string;
	/**
	 * Where every host's folder sits; by default the login's runtime
	 * folder's, which no fenced command sees, or the harness's state,
	 * which the fence holds read-only: node runs what it reads back from
	 * here outside the fence, so no fenced command may write it.
	 */
	readonly root?: string;
	/** Enables node's cache in a folder; node's own by default. */
	readonly enable?: (directory: string) => Enabled;
}

/**
 * A host's compile cache: on in its folder, off for a reason, or never
 * keyed, when the program will refuse the host it would serve.
 */
export type CompileCache =
	| { readonly state: "on"; readonly folder: string }
	| { readonly state: "off"; readonly reason: string }
	| { readonly state: "unkeyed" };

/** The host's realm and kind, and its install, when the program would take them. */
function keyOf(
	options: CompileCacheOptions,
): { host: string; install: string } | undefined {
	const packageDir = options.env.PI_PACKAGE_DIR;
	if (!packageDir || !isAbsolute(packageDir) || !existsSync(packageDir))
		return undefined;
	const [kind, ...rest] = options.argv;
	const child = kind === CHILD_FLAG;
	if (
		(kind !== "attended" && kind !== "background" && !child) ||
		rest.length > 0
	)
		return undefined;
	let host: string;
	try {
		// A child shares its host's cache, since it loads the same code.
		if (child) {
			host = options.env.PI_HOST_CHILD_KEY ?? "";
			hostKeyParts(host);
		} else host = hostKey(hostRealm(options.env), kind);
	} catch {
		// No realm or a bad one: the program refuses the host with the reason.
		return undefined;
	}
	const install = createHash("sha256")
		.update(`${realpathSync(packageDir)}\0${realpathSync(options.harnessRoot)}`)
		.digest("hex")
		.slice(0, INSTALL_KEY_CHARS);
	return { host, install };
}

/** Remove `host`'s folders in `root` but the one `keep` names. */
function sweepEarlier(
	root: string,
	host: string,
	keep: string | undefined,
): void {
	for (const entry of readdirSync(root))
		if (entry.startsWith(`${host}-`) && entry !== keep)
			rmSync(join(root, entry), { recursive: true, force: true });
}

/**
 * Enable node's compile cache for this host's install, removing the same
 * host's earlier installs' folders. Never throws: a cache that can't be
 * had is answered as off, with why.
 */
export function startCompileCache(options: CompileCacheOptions): CompileCache {
	try {
		const key = keyOf(options);
		if (!key) return { state: "unkeyed" };
		const root = options.root ?? compileFolderOf("host", options.env);
		const name = `${key.host}-${key.install}`;
		mkdirSync(root, { recursive: true });
		sweepEarlier(root, key.host, name);
		// Its folders from before the cache lay in the runtime folder, or
		// from a start that found none, which no later start would reach.
		const inState = stateDir("host-compile");
		if (!options.root && inState !== root && existsSync(inState))
			sweepEarlier(inState, key.host, undefined);
		const folder = join(root, name);
		mkdirSync(folder, { recursive: true });
		const enabled = (options.enable ?? enableCompileCache)(folder);
		if (enabled.status === constants.compileCacheStatus.FAILED)
			return {
				state: "off",
				reason: enabled.message ?? "node could not enable it",
			};
		return { state: "on", folder };
	} catch (error) {
		return {
			state: "off",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
