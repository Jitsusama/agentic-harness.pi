/**
 * The JavaScript node strips from this package's TypeScript, kept so a
 * later start reads it back rather than stripping again.
 *
 * node 22 strips a module's types with amaro, a WebAssembly build of
 * swc that it loads with the first `.ts` a process imports and keeps
 * for the life of the process. Loading the host's program that way
 * held about 47 MB more resident memory than loading the same modules
 * already stripped, and node 22's compile cache doesn't spare it: node
 * asks amaro even to tell a `.ts` module's format. Every conversation's
 * child host runs on node 22 from `.ts`, so each paid it. node 24's
 * compile cache keeps what it stripped, so there this stands aside.
 *
 * A load hook answers each `.ts` or `.mts` module from a file named by
 * the hash of its URL and source, holding the format node gave it and
 * the text node's own strip makes of it, so a module reads the same
 * either way. A module not kept yet goes to node, which tells its
 * format, and is stripped as node would strip it; the entry is written
 * after, off the loading thread. Only ES modules are kept.
 *
 * The entries lie in pi's state, which a fenced command can't write:
 * node runs them as code outside the fence. Each install keeps its own
 * folder, named by the install's path and node's version, and a start
 * removes the folders of installs no longer on the disk.
 *
 * Plain `.mjs`, since it must be running before node loads any of this
 * package's TypeScript, its own entry included.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The variable that turns the cache off when it reads `off`. */
export const OFF_VARIABLE = "PI_STRIPPED_SOURCE_CACHE";

/** The only node whose compile cache doesn't keep what it stripped. */
const STRIPPING_MAJOR = 22;

/** What node's own load answers a TypeScript ES module as. */
const TYPESCRIPT_MODULE = "module-typescript";

/** The format a kept entry is read back as. */
const MODULE = "module";

/** A module URL whose source node would strip. */
const TYPESCRIPT_URL = /^file:.*\.m?ts$/;

/** How many hex characters of an install's hash name its folder. */
const INSTALL_KEY_CHARS = 16;

/** The file in an install's folder naming the install it serves. */
const ROOT_FILE = "root";

/**
 * How old a folder naming no install must be before a sweep takes it:
 * a start makes its folder, then names its install in it.
 */
const UNNAMED_GRACE_MS = 60 * 60 * 1000;

/** This package's root, two folders above this file. */
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Why the cache stands aside in a process like `facts` describes, or
 * undefined when it serves.
 *
 * @type {typeof import("./stripped-source.d.mts").whyNot}
 */
export function whyNot(facts) {
	if (facts.env[OFF_VARIABLE] === "off") return `${OFF_VARIABLE} is off`;
	const major = Number(facts.version.replace(/^v/, "").split(".")[0]);
	if (major !== STRIPPING_MAJOR)
		return `node ${facts.version} keeps what it strips in its compile cache`;
	if (facts.typescript !== "strip")
		return "node isn't stripping types, so its output isn't this cache's";
	if (facts.sourceMaps)
		return "source maps are on, which node's own strip writes and this doesn't";
	return undefined;
}

/**
 * The folder of pi's state that every install's folder lies in.
 *
 * @type {typeof import("./stripped-source.d.mts").cacheRoot}
 */
export function cacheRoot(env, home) {
	const state = env.XDG_STATE_HOME;
	const root =
		state && isAbsolute(state) ? state : join(home, ".local", "state");
	return join(root, "pi", "agentic-harness.pi", "stripped-source");
}

/**
 * The folder name for the install at `packageRoot` under node `version`.
 *
 * @type {typeof import("./stripped-source.d.mts").installKey}
 */
export function installKey(packageRoot, version) {
	return createHash("sha256")
		.update(`${packageRoot}\0${version}`)
		.digest("hex")
		.slice(0, INSTALL_KEY_CHARS);
}

/**
 * The name of the entry holding `url` as it reads `source`.
 *
 * @param {string} url
 * @param {string} source
 * @returns {string}
 */
function entryName(url, source) {
	return createHash("sha256")
		.update(url)
		.update("\0")
		.update(source)
		.digest("hex");
}

/**
 * The format and text an entry holds, or undefined for one that holds
 * neither, as a file cut short would.
 *
 * @param {string} text
 * @returns {string | undefined}
 */
function readEntry(text) {
	const newline = text.indexOf("\n");
	if (newline < 0 || text.slice(0, newline) !== MODULE) return undefined;
	return text.slice(newline + 1);
}

/**
 * A load hook keeping in `folder` what node strips, given what it
 * reads files with (`read`), strips with (`strip`) and hands each new
 * entry to (`keep`).
 *
 * @type {typeof import("./stripped-source.d.mts").strippedSourceLoad}
 */
export function strippedSourceLoad({ folder, read, strip, keep }) {
	return (url, context, nextLoad) => {
		if (!TYPESCRIPT_URL.test(url)) return nextLoad(url, context);
		const source = read(fileURLToPath(url));
		const file = join(folder, entryName(url, source));
		let kept;
		try {
			kept = readEntry(read(file));
		} catch {
			// Not kept yet: node tells its format below.
		}
		if (kept !== undefined)
			return { format: MODULE, source: kept, shortCircuit: true };
		const loaded = nextLoad(url, context);
		if (loaded.format !== TYPESCRIPT_MODULE) return loaded;
		const stripped = strip(source, url);
		keep(file, `${MODULE}\n${stripped}`);
		return { format: MODULE, source: stripped, shortCircuit: true };
	};
}

/**
 * Strip `source` as node strips a module at `url`.
 *
 * @param {string} source
 * @param {string} url
 * @returns {string}
 */
function stripAsNode(source, url) {
	return stripTypeScriptTypes(source, { mode: "strip", sourceUrl: url });
}

/**
 * Write `text` to `file` whole or not at all, through a file of this
 * process's own beside it.
 *
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeWhole(file, text) {
	const partial = `${file}.${process.pid}`;
	await writeFile(partial, text, { mode: 0o600 });
	await rename(partial, file);
}

/**
 * A writer for `folder`'s entries: each is queued as it is made and
 * written once the loading that made it has let go of the thread.
 *
 * @type {typeof import("./stripped-source.d.mts").entryWriter}
 */
export function entryWriter(folder, packageRoot) {
	/** @type {[string, string][]} */
	const queue = [];
	let started = false;
	const flush = async () => {
		try {
			await mkdir(folder, { recursive: true, mode: 0o700 });
			await writeWhole(join(folder, ROOT_FILE), packageRoot);
			for (let next = queue.shift(); next; next = queue.shift())
				await writeWhole(...next);
		} catch {
			// Only the next start's time is lost: it strips again.
		} finally {
			started = false;
		}
	};
	return (file, text) => {
		queue.push([file, text]);
		if (started) return;
		started = true;
		setImmediate(flush);
	};
}

/**
 * Remove the folders in `root` but `keep` whose install is gone from
 * the disk, or that name none an hour after they were made.
 *
 * @type {typeof import("./stripped-source.d.mts").sweepGone}
 */
export async function sweepGone(root, keep, now = Date.now()) {
	/** @type {string[]} */
	let names;
	try {
		names = await readdir(root);
	} catch {
		// No folder yet: nothing kept to sweep.
		return;
	}
	for (const name of names) {
		if (name === keep) continue;
		const folder = join(root, name);
		try {
			const served = await readFile(join(folder, ROOT_FILE), "utf8").catch(
				() => undefined,
			);
			const gone =
				served === undefined
					? now - (await stat(folder)).mtimeMs > UNNAMED_GRACE_MS
					: !(await stat(served).then(
							() => true,
							() => false,
						));
			if (gone) await rm(folder, { recursive: true, force: true });
		} catch {
			// Another start swept it first, or it can't be read: left for later.
		}
	}
}

/**
 * Keep what node strips of this package for this process and every
 * later one, where node 22 strips it. Never throws: answers whether it
 * does, why it stands aside, or why it failed, in which case node
 * strips as it always has.
 *
 * @type {typeof import("./stripped-source.d.mts").startStrippedSourceCache}
 */
export function startStrippedSourceCache(options = {}) {
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const facts = options.facts ?? {
		env,
		version: process.version,
		typescript: process.features.typescript,
		sourceMaps: process.sourceMapsEnabled,
	};
	const register = options.register ?? registerHooks;
	const reason = whyNot(facts);
	if (reason) return { state: "off", reason };
	try {
		const served = options.packageRoot ?? realpathSync(PACKAGE_ROOT);
		const root = cacheRoot(env, home);
		const name = installKey(served, facts.version);
		const folder = join(root, name);
		register({
			load: strippedSourceLoad({
				folder,
				read: (path) => readFileSync(path, "utf8"),
				strip: stripAsNode,
				keep: entryWriter(folder, served),
			}),
		});
		setImmediate(() => void sweepGone(root, name));
		return { state: "on", folder };
	} catch (error) {
		return {
			state: "failed",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
