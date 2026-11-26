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
 * A load hook answers each of this package's own `.ts` or `.mts`
 * modules (none under node_modules) from a file named by the hash of
 * its URL and source, holding the text node's own strip makes of it and
 * that text's hash, so a module reads the same either way and an entry
 * damaged on disk is never run. A module not kept yet goes to node,
 * which tells its format, and is stripped as node would strip it; the
 * entry is written after, off the loading thread. Only ES modules are
 * kept.
 *
 * The entries lie in pi's state, ~/.local/state/pi, which the fence
 * keeps read-only to its commands but for the work trees it binds back
 * writable, under work/trees; the cache's folder lies beside them. node
 * runs the entries as code outside the fence, so the cache stands aside
 * where XDG_STATE_HOME puts pi's state anywhere else. One naming a
 * folder in a work tree would pass, but it is set by whatever starts
 * node, which no fenced command is. The entries are read only while
 * every folder from there down to the install's is this login's own, no
 * other's to write and no link, and the install's is closed to others
 * too. A start first closes to others each folder above the install's,
 * as the host does those above its record, since code before it may
 * have made them under a looser umask; the install's own is made
 * private whatever the umask, so one found open is left so, and the
 * cache fails rather than trust what it holds. That keeps out other
 * logins and links; against a fenced command of this login, the fence's
 * hold on that folder is the guard, as it is for the hosts' records.
 * Each install keeps its own folder, named by the install's path, its
 * package type and node's version. A start removes the folders of
 * installs no longer on the disk, and of its own install under another
 * node once none of their entries has been read for two days, since a
 * start from before a switch may still read them; and the entries of
 * its own folder no start has read for 30 days.
 *
 * Plain `.mjs`, since it must be running before node loads any of this
 * package's TypeScript, its own entry included.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
// A namespace rather than named imports, so a node lacking either hook
// still loads this and is told why the cache stands aside.
import * as nodeModule from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The variable that turns the cache off when it reads `off`. */
export const OFF_VARIABLE = "PI_STRIPPED_SOURCE_CACHE";

/** The only node whose compile cache doesn't keep what it stripped. */
const STRIPPING_MAJOR = 22;

/** What node's own load answers a TypeScript ES module as. */
const TYPESCRIPT_MODULE = "module-typescript";

/** The format a kept entry is read back as. */
const MODULE = "module";

/** What opens an entry's first line, before its text's hash. */
const ENTRY_HEAD = `${MODULE} `;

/** A module URL whose source node would strip. */
const TYPESCRIPT_URL = /^file:.*\.m?ts$/;

/** What node 22 warns the first time its strip is called from code. */
const STRIP_WARNING = "stripTypeScriptTypes is an experimental feature";

/** How many hex characters of an install's hash name its folder. */
const INSTALL_KEY_CHARS = 16;

/** The file in an install's folder naming the install and node it serves. */
const ROOT_FILE = "root";

/** Owner, group and others' bits beyond the owner's own. */
const SHARED_BITS = 0o077;

/** Group and others' write bits. */
const OTHERS_WRITE = 0o022;

/** Only the owner may enter, list or write. */
const PRIVATE_MODE = 0o700;

/**
 * How old a folder naming no install must be before a sweep takes it:
 * a start makes its folder, then names its install in it.
 */
const UNNAMED_GRACE_MS = 60 * 60 * 1000;

/** How long since an entry was last read before a hit marks it read again. */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * How long none of the entries in its own install's folder under another
 * node must have been marked read before a sweep takes it: a read marks
 * an entry only once it is a day old, so its last read may come a day
 * after its mark, and three days since the newest mark leaves at least
 * the two days since the last read that the header promises.
 */
const OTHER_NODE_IDLE_MS = 3 * TOUCH_AFTER_MS;

/** How long an entry no start has read is kept. */
const ENTRY_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

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
	if (!facts.hooks)
		return `node ${facts.version} has no registerHooks or stripTypeScriptTypes`;
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
 * The folder of pi's state the fence keeps read-only to its commands,
 * which every install's folder must lie in (fence-home.ts).
 *
 * @type {typeof import("./stripped-source.d.mts").heldState}
 */
export function heldState(home) {
	return join(home, ".local", "state", "pi");
}

/**
 * The folder name for the install at `packageRoot` under node `version`,
 * its package.json naming `type`.
 *
 * @type {typeof import("./stripped-source.d.mts").installKey}
 */
export function installKey(packageRoot, version, type = "") {
	return createHash("sha256")
		.update(`${packageRoot}\0${version}\0${type}`)
		.digest("hex")
		.slice(0, INSTALL_KEY_CHARS);
}

/**
 * The `type` the package.json at `packageRoot` names, or "" for none,
 * since node tells a `.ts` module's format by it.
 *
 * @param {string} packageRoot
 * @returns {string}
 */
function packageType(packageRoot) {
	try {
		const manifest = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		);
		return typeof manifest?.type === "string" ? manifest.type : "";
	} catch {
		// No readable package.json: node tells the format from the syntax.
		return "";
	}
}

/**
 * The hex SHA-256 of `text`.
 *
 * @param {string} text
 * @returns {string}
 */
function hashOf(text) {
	return createHash("sha256").update(text).digest("hex");
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
 * What an entry holding `stripped` reads on disk.
 *
 * @type {typeof import("./stripped-source.d.mts").entryText}
 */
export function entryText(stripped) {
	return `${ENTRY_HEAD}${hashOf(stripped)}\n${stripped}`;
}

/**
 * The text an entry holds, or undefined for one whose text is not what
 * its hash says, as a file cut short or damaged would be.
 *
 * @param {string} text
 * @returns {string | undefined}
 */
function readEntry(text) {
	const newline = text.indexOf("\n");
	if (newline < 0) return undefined;
	const head = text.slice(0, newline);
	if (!head.startsWith(ENTRY_HEAD)) return undefined;
	const stripped = text.slice(newline + 1);
	return hashOf(stripped) === head.slice(ENTRY_HEAD.length)
		? stripped
		: undefined;
}

/**
 * Whether `url` is one of the package's own modules at `within`, a
 * folder's URL ending in a slash, rather than a dependency's.
 *
 * @param {string} url
 * @param {string} within
 * @returns {boolean}
 */
function ownModule(url, within) {
	return (
		url.startsWith(within) &&
		!`/${url.slice(within.length)}`.includes("/node_modules/")
	);
}

/**
 * A load hook keeping in `folder` what node strips of the modules
 * `within` holds, given what it reads files with (`read`), strips with
 * (`strip`), hands each new entry to (`keep`), asks whether the folder
 * may be read (`trusted`) and tells of each entry it reads (`touch`).
 *
 * @type {typeof import("./stripped-source.d.mts").strippedSourceLoad}
 */
export function strippedSourceLoad({
	folder,
	within,
	read,
	strip,
	keep,
	trusted = () => true,
	touch = () => {},
}) {
	return (url, context, nextLoad) => {
		if (!TYPESCRIPT_URL.test(url) || !ownModule(url, within))
			return nextLoad(url, context);
		const source = read(fileURLToPath(url));
		const file = join(folder, entryName(url, source));
		let kept;
		if (trusted()) {
			try {
				kept = readEntry(read(file));
			} catch {
				// Not kept yet: node tells its format below.
			}
		}
		if (kept !== undefined) {
			touch(file);
			return { format: MODULE, source: kept, shortCircuit: true };
		}
		const loaded = nextLoad(url, context);
		if (loaded.format !== TYPESCRIPT_MODULE) return loaded;
		const stripped = strip(source, url);
		keep(file, entryText(stripped));
		return { format: MODULE, source: stripped, shortCircuit: true };
	};
}

/**
 * Strip `source` as node strips a module at `url`. node 22 warns the
 * first time code calls its strip, which its own load calls silently;
 * that one warning is held back, since it is about this very call and
 * would come ahead of what a start says on stderr.
 *
 * @param {string} source
 * @param {string} url
 * @returns {string}
 */
function stripAsNode(source, url) {
	const emit = process.emitWarning;
	/** @type {typeof process.emitWarning} */
	const sifted = (warning, ...rest) => {
		const said = warning instanceof Error ? warning.message : String(warning);
		if (!said.startsWith(STRIP_WARNING))
			Reflect.apply(emit, process, [warning, ...rest]);
	};
	process.emitWarning = sifted;
	try {
		return nodeModule.stripTypeScriptTypes(source, {
			mode: "strip",
			sourceUrl: url,
		});
	} finally {
		process.emitWarning = emit;
	}
}

/**
 * Where `folder` stands: missing, or a folder of this login's own
 * closed to others lying in `held`, with each folder from `held` down
 * to it this login's own, no other's to write and at its real path; or
 * anything else, which is never read from, with why, naming the first
 * folder from `held` down that fails.
 *
 * @param {string} folder
 * @param {string} held
 * @returns {Place}
 */
function placeOf(folder, held) {
	const folders = downTo(folder, held);
	if (!folders)
		return { place: "open", why: `${folder} doesn't lie within ${held}` };
	for (const [index, each] of folders.entries()) {
		const place = standing(
			each,
			index === folders.length - 1 ? SHARED_BITS : OTHERS_WRITE,
		);
		if (place.place !== "private") return place;
	}
	return { place: "private" };
}

/**
 * `held` and each folder below it down to `folder`, or undefined where
 * `folder` doesn't lie below it.
 *
 * @param {string} folder
 * @param {string} held
 * @returns {string[] | undefined}
 */
function downTo(folder, held) {
	const at = relative(held, folder);
	if (at === "" || at.startsWith("..") || isAbsolute(at)) return undefined;
	const steps = at.split(sep);
	return [
		held,
		...steps.map((_, index) => join(held, ...steps.slice(0, index + 1))),
	];
}

/**
 * Clear group and other write from each folder from `held` down to the
 * one holding `folder` that is this login's own and at its real path,
 * as code before this start, the host's among it, may have made them
 * under a looser umask; placeOf then judges them as they stand. The
 * walk stops at the first that isn't at its real path, so nothing past
 * a link is changed. `folder` itself is left as it is: it is made
 * private whatever the umask, so one open to others was opened since,
 * and what it holds can't be trusted however it is closed now.
 *
 * @param {string} folder
 * @param {string} held
 */
function closeAbove(folder, held) {
	for (const each of (downTo(folder, held) ?? []).slice(0, -1)) {
		let opened;
		try {
			if (realpathSync(each) !== each) return;
			opened = openSync(
				each,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
		} catch {
			// Missing or unreadable: placeOf says which, as it stands.
			return;
		}
		try {
			const seen = fstatSync(opened);
			if (seen.uid === process.getuid?.() && (seen.mode & OTHERS_WRITE) !== 0)
				fchmodSync(opened, seen.mode & ~OTHERS_WRITE & 0o7777);
		} catch {
			// Left as it is: placeOf judges it and says why.
		} finally {
			closeSync(opened);
		}
	}
}

/**
 * @typedef {{ place: "missing" | "private" } | { place: "open", why: string }} Place
 */

/**
 * Whether `folder` is missing, or a real folder of this login's own at
 * its real path with none of `shared` set, or anything else, and why.
 *
 * @param {string} folder
 * @param {number} shared
 * @returns {Place}
 */
function standing(folder, shared) {
	/** @param {string} why */
	const open = (why) => ({ place: /** @type {const} */ ("open"), why });
	try {
		const seen = lstatSync(folder);
		if (seen.isSymbolicLink()) return open(`${folder} is a link`);
		if (!seen.isDirectory()) return open(`${folder} isn't a folder`);
		const really = realpathSync(folder);
		if (really !== folder)
			return open(`${folder} lies through a link, at ${really}`);
		const uid = process.getuid?.();
		if (uid !== undefined && seen.uid !== uid)
			return open(`${folder} belongs to another login`);
		const bits = seen.mode & shared;
		if (bits !== 0)
			return open(
				`${folder} has mode ${(seen.mode & 0o777).toString(8)}, ${shared === OTHERS_WRITE ? "which others may write" : "open to others"}`,
			);
		return { place: "private" };
	} catch (error) {
		return codeOf(error) === "ENOENT"
			? { place: "missing" }
			: open(`${folder} can't be looked at: ${messageOf(error)}`);
	}
}

/**
 * The code a failed file call gave, or undefined.
 *
 * @param {unknown} error
 * @returns {string | undefined}
 */
function codeOf(error) {
	return error instanceof Error &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: undefined;
}

/**
 * What `error` says.
 *
 * @param {unknown} error
 * @returns {string}
 */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Write `text` to `file` whole or not at all, through a file of its own
 * beside it that no other may already hold, removed if the write fails.
 *
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeWhole(file, text) {
	const partial = `${file}.${randomBytes(8).toString("hex")}.part`;
	try {
		await writeFile(partial, text, { mode: 0o600, flag: "wx" });
		await rename(partial, file);
	} catch (error) {
		await rm(partial, { force: true }).catch(() => {
			// Left for the sweep, which takes entries no start has read.
		});
		throw error;
	}
}

/**
 * A writer for `folder`'s entries: each is queued as it is made and
 * written once the loading that made it has let go of the thread. The
 * folder is made private, `made` told once it stands as the start
 * would read from it in `held`, and the install and node it serves
 * named in it. The first write that fails is said to
 * `report`, and the writer keeps nothing more this run.
 *
 * @type {typeof import("./stripped-source.d.mts").entryWriter}
 */
export function entryWriter({
	folder,
	held,
	served,
	version,
	report = () => {},
	made = () => {},
}) {
	/** @type {[string, string][]} */
	let queue = [];
	let started = false;
	let stopped = false;
	const flush = async () => {
		try {
			await mkdir(folder, { recursive: true, mode: PRIVATE_MODE });
			closeAbove(folder, held);
			const stands = placeOf(folder, held);
			if (stands.place !== "private")
				throw new Error(
					`${stands.place === "open" ? stands.why : `${folder} wasn't made`}, so nothing is kept in it`,
				);
			made();
			await writeWhole(join(folder, ROOT_FILE), `${served}\n${version}`);
			for (let next = queue.shift(); next; next = queue.shift())
				await writeWhole(...next);
		} catch (error) {
			stopped = true;
			queue = [];
			report(
				`the stripped-source cache keeps nothing more this run, so a later start strips again: ${messageOf(error)}`,
			);
		} finally {
			started = false;
		}
	};
	return (file, text) => {
		if (stopped) return;
		queue.push([file, text]);
		if (started) return;
		started = true;
		setImmediate(flush);
	};
}

/**
 * Mark the entry `file` read now when it was last marked over a day
 * ago, so the sweep keeps what starts still read.
 *
 * @param {string} file
 * @param {number} now
 * @returns {Promise<void>}
 */
async function touchIfOld(file, now = Date.now()) {
	try {
		const seen = await stat(file);
		if (now - seen.mtimeMs <= TOUCH_AFTER_MS) return;
		const at = now / 1000;
		await utimes(file, at, at);
	} catch {
		// Swept meanwhile: a later start strips it again.
	}
}

/**
 * Whether something stands at `path`: only a path that is missing, or
 * runs through a file, counts as gone, so one that can't be looked at
 * now is left for a later sweep.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function stands(path) {
	if (!path) return false;
	try {
		await stat(path);
		return true;
	} catch (error) {
		const code = codeOf(error);
		return code !== "ENOENT" && code !== "ENOTDIR";
	}
}

/**
 * Remove the entries in `folder` no start has read for 30 days.
 *
 * @param {string} folder
 * @param {number} now
 * @returns {Promise<void>}
 */
async function pruneEntries(folder, now) {
	for (const name of await readdir(folder)) {
		if (name === ROOT_FILE) continue;
		const file = join(folder, name);
		try {
			if (now - (await stat(file)).mtimeMs > ENTRY_LIFE_MS)
				await rm(file, { force: true });
		} catch {
			// Gone meanwhile, or not to be looked at: left for later.
		}
	}
}

/**
 * When anything in `folder` was last written or marked read: the
 * folder's own time and each of its files'.
 *
 * @param {string} folder
 * @returns {Promise<number>}
 */
async function lastUsed(folder) {
	let last = (await stat(folder)).mtimeMs;
	for (const name of await readdir(folder))
		try {
			last = Math.max(last, (await stat(join(folder, name))).mtimeMs);
		} catch {
			// Gone meanwhile: it marks no use.
		}
	return last;
}

/**
 * Remove the folders in `root` but `keep` whose install is gone from
 * the disk, that hold `served` under a node other than `version` and
 * none of whose entries was read for two days, or that name none an
 * hour after they were made; and the entries in `keep` no start has
 * read for 30 days.
 *
 * @type {typeof import("./stripped-source.d.mts").sweepGone}
 */
export async function sweepGone({
	root,
	keep,
	served,
	version,
	now = Date.now(),
}) {
	/** @type {string[]} */
	let names;
	try {
		names = await readdir(root);
	} catch {
		// No folder yet: nothing kept to sweep.
		return;
	}
	for (const name of names) {
		const folder = join(root, name);
		try {
			if (name === keep) {
				await pruneEntries(folder, now);
				continue;
			}
			const named = await readFile(join(folder, ROOT_FILE), "utf8").catch(
				() => undefined,
			);
			let gone;
			if (named === undefined)
				gone = now - (await stat(folder)).mtimeMs > UNNAMED_GRACE_MS;
			else {
				const [install = "", ranOn] = named.split("\n");
				gone =
					(install === served &&
						ranOn !== version &&
						now - (await lastUsed(folder)) > OTHER_NODE_IDLE_MS) ||
					!(await stands(install));
			}
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
 * strips as it always has. A write that fails later is said to
 * `report`.
 *
 * @type {typeof import("./stripped-source.d.mts").startStrippedSourceCache}
 */
export function startStrippedSourceCache(options = {}) {
	try {
		const env = options.env ?? process.env;
		const facts = options.facts ?? {
			env,
			version: process.version,
			typescript: process.features.typescript,
			sourceMaps: process.sourceMapsEnabled,
			hooks:
				typeof nodeModule.registerHooks === "function" &&
				typeof nodeModule.stripTypeScriptTypes === "function",
		};
		const reason = whyNot(facts);
		if (reason) return { state: "off", reason };
		const home = options.home ?? homedir();
		const register = options.register ?? nodeModule.registerHooks;
		const served = options.packageRoot ?? realpathSync(PACKAGE_ROOT);
		const root = cacheRoot(env, home);
		const held = heldState(home);
		if (relative(held, resolve(root)).startsWith(".."))
			return {
				state: "off",
				reason: `pi's state lies outside ${held}, which the fence keeps read-only, so nothing kept there could be trusted`,
			};
		const name = installKey(served, facts.version, packageType(served));
		const folder = join(root, name);
		closeAbove(folder, held);
		const place = placeOf(folder, held);
		if (place.place === "open")
			return {
				state: "failed",
				reason: `${place.why}, where each folder from ${held} down to ${folder} must be this login's own, closed to others and at its real path, so nothing in it is run`,
			};
		let trusted = place.place === "private";
		register({
			load: strippedSourceLoad({
				folder,
				within: `${pathToFileURL(served).href}/`,
				read: (path) => readFileSync(path, "utf8"),
				strip: stripAsNode,
				keep: entryWriter({
					folder,
					held,
					served,
					version: facts.version,
					report: options.report,
					made: () => {
						trusted = true;
					},
				}),
				trusted: () => trusted,
				touch: (file) => void touchIfOld(file),
			}),
		});
		setImmediate(
			() =>
				void sweepGone({ root, keep: name, served, version: facts.version }),
		);
		return { state: "on", folder };
	} catch (error) {
		return { state: "failed", reason: messageOf(error) };
	}
}
