/**
 * Which code this pi runs, said where core.nix's pi-packages reads it.
 *
 * pi-packages removes a version of a package once no pi runs it. It
 * can't tell that from what a pi maps: a pi keeps each version's native
 * sqlite addon mapped after it reloads onto the next, since one can't be
 * unloaded, so on 29 October all fifteen pis mapped nearly all 24 of the
 * harness's versions, 8.5 GiB, and none went. So each pi writes
 * `<package>/loaded/<pid>`, holding the root it loaded, at every load,
 * and removes it as it ends; pi-packages trusts that over the maps.
 *
 * The file also names the pi that runs it. jiti names its cache entries
 * by each file's path, and each swap moves the package to a new one, so
 * on 12 November the first start of each pi after a swap transpiled all
 * 1,120 files again: 15 s cold against 1.4 s warm. pi-packages warms the
 * cache before a swap through each pi a file names, since another pi's
 * jiti may name or tag its entries differently.
 */

import {
	existsSync,
	mkdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { installOfVersion } from "./loaded.ts";

/** The folder of a package's install that its pis say what they loaded in. */
export const LOADED_FOLDER = "loaded";

/** Where pi's bundle sits in a runtime a host names by `PI_PACKAGE_DIR`. */
const RUNTIME_BUNDLE = "lib/node_modules/pi-monorepo/dist/bundle";

/** The command that starts pi, in its bundle. */
const PI_COMMAND = "cli.js";

/** The pi a process runs, so another program can start the same one. */
export interface RunningPi {
	/** The folder of pi's bundle, holding the `cli.js` that starts it. */
	readonly bundle: string;
	/** The node that runs it. */
	readonly node: string;
	/** Its temporary folder, under which jiti keeps its cache. */
	readonly tmp: string;
}

/** What a process says of how it was started. */
interface Started {
	readonly argv: readonly string[];
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly node: string;
	readonly tmp: string;
}

/**
 * The pi this process runs: the bundle whose `cli.js` started it, or else
 * the runtime a host names in `PI_PACKAGE_DIR`, since a host starts a
 * script of its own. Nothing when neither names a bundle.
 */
export function runningPi(
	started: Started = {
		argv: process.argv,
		env: process.env,
		node: process.execPath,
		tmp: tmpdir(),
	},
): RunningPi | undefined {
	const { node, tmp } = started;
	const script = started.argv[1];
	if (script !== undefined && basename(script) === PI_COMMAND)
		return { bundle: dirname(script), node, tmp };
	const runtime = started.env.PI_PACKAGE_DIR;
	if (!runtime) return undefined;
	const bundle = join(runtime, RUNTIME_BUNDLE);
	return existsSync(join(bundle, PI_COMMAND))
		? { bundle, node, tmp }
		: undefined;
}

/**
 * The install folder pi-packages keeps the package in: the one above the
 * version `root` is, or else the one above the version pi's settings
 * install, as when the pi runs a tree. Nothing for a package pi-packages
 * doesn't keep.
 */
export function packageFolderOf(
	root: string,
	install: string | undefined,
): string | undefined {
	const of = installOfVersion(root);
	if (of !== undefined || install === undefined) return of;
	try {
		return installOfVersion(realpathSync(install));
	} catch {
		// An install that isn't there keeps nothing this pi could say.
		return undefined;
	}
}

/**
 * Says this pi runs `root`, writing the file through a rename so a reader
 * finds the old answer or the new, never half of one. Answers the file,
 * or nothing when the package isn't one pi-packages keeps or the file
 * couldn't be written: saying nothing leaves pi-packages to the pi's
 * maps, as before, which only keeps more.
 */
export function sayLoaded(
	root: string,
	install: string | undefined,
	pid: number = process.pid,
	pi: RunningPi | undefined = runningPi(),
): string | undefined {
	const folder = packageFolderOf(root, install);
	if (folder === undefined) return undefined;
	return sayLoadedIn(join(folder, LOADED_FOLDER, String(pid)), root, pi);
}

/**
 * Says this pi runs `root` in the file it said in before. A pi reloaded
 * onto a tree has its settings pointed at the tree for the reload, so
 * neither names the install's folder; its process's file is still the
 * one to say it in, since the folder can't change under a process, and
 * left alone it would go on naming the version the pi left. Answers
 * the file, or nothing when it couldn't be written.
 */
export function sayLoadedIn(
	file: string,
	root: string,
	pi: RunningPi | undefined = runningPi(),
): string | undefined {
	const dir = dirname(file);
	const writing = join(dir, `.${basename(file)}.new`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(writing, `${JSON.stringify(pi ? { root, pi } : { root })}\n`);
		renameSync(writing, file);
		return file;
	} catch {
		// See above: an unsaid pi keeps its versions by its maps.
		return undefined;
	}
}

/** Takes back what a pi said, as it ends. */
export function unsayLoaded(file: string): void {
	rmSync(file, { force: true });
}
