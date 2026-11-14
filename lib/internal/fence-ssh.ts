/**
 * The system's SSH settings as a fenced ssh can read them. bubblewrap
 * maps only the person's own account into the fence, so root's files
 * show inside as nobody's, and ssh refuses a file its settings include
 * whose owner is neither root nor the caller: on NixOS the system's
 * settings include libvirt's and systemd's, so every ssh inside failed
 * with "Bad owner or permissions". The system's own settings file isn't
 * checked, so a copy of it with each included file written in, made
 * outside and owned by the person, is bound over it inside.
 *
 * A fenced command could hand ssh settings of its own (`ssh -F`) and the
 * copy changes nothing ssh may reach: what it may sign with is the
 * agent's proxy's to say.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SYSTEM_SSH_CONFIG } from "./fence.ts";
import { fenceCopy } from "./fence-copy.ts";

/** How deep includes nest before ssh itself gives up, as OpenSSH has it. */
const MOST_DEPTH = 16;

/** An `Include` line, with what it names. */
const INCLUDE = /^\s*include(?:\s*=\s*|\s+)(.*?)\s*$/i;

/** What inlining needs of the disk: a file's text, and a folder's names. */
export interface SshFiles {
	read(path: string): string | undefined;
	entries(folder: string): readonly string[];
}

/** The files on this disk. */
const FILES: SshFiles = {
	read(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			// Not there or not readable: ssh skips an include it can't open.
			return undefined;
		}
	},
	entries(folder) {
		try {
			return readdirSync(folder);
		} catch {
			// No folder, so no file in it to include.
			return [];
		}
	},
};

/** Whether `name` is matched by `pattern`, with ssh's `*` and `?`. */
function matches(pattern: string, name: string): boolean {
	const source = pattern
		.split("")
		.map((char) => {
			if (char === "*") return ".*";
			if (char === "?") return ".";
			return char.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
		})
		.join("");
	return new RegExp(`^${source}$`).test(name);
}

/**
 * The files one word of an `Include` names, in the order ssh reads
 * them: relative to `/etc/ssh`, as the system's settings take them, and
 * a pattern only in the file's own name.
 */
function included(word: string, files: SshFiles): string[] {
	const path = word.startsWith("/") ? word : join("/etc/ssh", word);
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (!/[*?]/.test(name)) return [path];
	const folder = dirname(path);
	return [...files.entries(folder)]
		.filter((entry) => matches(name, entry))
		.sort()
		.map((entry) => join(folder, entry));
}

/**
 * `text` with each `Include` line replaced by the files it names, theirs
 * in turn, or nothing when it has none. A word ssh would read with
 * quotes or a `~` is left as it was, since its meaning is the shell's
 * rather than a path's.
 */
export function inlinedSshConfig(
	text: string,
	files: SshFiles = FILES,
	depth = 0,
): string | undefined {
	const lines = text.split("\n");
	if (!lines.some((line) => INCLUDE.test(line))) return undefined;
	const out: string[] = [];
	for (const line of lines) {
		const words = INCLUDE.exec(line)?.[1]?.split(/\s+/).filter(Boolean);
		if (
			words === undefined ||
			depth >= MOST_DEPTH ||
			words.some((word) => /["'~]/.test(word))
		) {
			out.push(line);
			continue;
		}
		out.push(`# ${line.trim()}, written in by the agent fence`);
		for (const path of words.flatMap((word) => included(word, files))) {
			const inner = files.read(path);
			if (inner === undefined) continue;
			out.push(inlinedSshConfig(inner, files, depth + 1) ?? inner);
		}
	}
	return out.join("\n");
}

/**
 * The copy of the system's SSH settings the fence binds over them, in
 * pi's own folder in the runtime folder, written when it changes; or
 * nothing when they include no file and need no copy.
 */
export function fenceSshConfig(
	runtimeDir: string | undefined,
	files: SshFiles = FILES,
): string | undefined {
	if (!runtimeDir) return undefined;
	const system = files.read(SYSTEM_SSH_CONFIG);
	const copy =
		system === undefined ? undefined : inlinedSshConfig(system, files);
	if (copy === undefined) return undefined;
	// With no copy to bind, commands still run, and an ssh inside refuses
	// the system's includes itself, saying which and why.
	return fenceCopy(runtimeDir, "ssh_config", copy, files.read);
}
