/**
 * The code a folder's own .pi makes pi run outside the sandbox, and
 * whether the host may load it: only as it stood when it was allowed.
 *
 * A fenced command can write a trusted folder's .pi, and the host loads
 * that folder's extensions, MCP servers and packages outside the fence
 * at the conversation's next load. So trusting a folder isn't enough:
 * the host pins the exact contents of that code in its agent folder,
 * which no fenced command can write, and loads it only while it still
 * matches. Code already on the disk when the host first pinned anything
 * is pinned as it is found, so what worked before keeps working; code
 * that arrives or changes after needs the person's yes. Skills, prompts
 * and themes are words and pictures pi reads, not code it runs, so they
 * stay under pi's own trust alone.
 */
import { createHash } from "node:crypto";
import {
	type Dirent,
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

/** The entries of a folder's .pi that pi runs as code, as pi names them. */
const CODE_ENTRIES = ["extensions", "mcp.json", "npm", "git"] as const;

/** The folder's own settings, of which only CODE_SETTINGS count. */
const SETTINGS = "settings.json";

/**
 * The settings that start a program outside the sandbox, or say where
 * pi sends its traffic or keeps its conversations. The rest, such as
 * compaction's, change how pi behaves, not what runs, so they stay
 * under pi's own trust alone.
 */
const CODE_SETTINGS = [
	"packages",
	"extensions",
	"shellPath",
	"shellCommandPrefix",
	"npmCommand",
	"selfUpdateCommand",
	"externalEditor",
	"httpProxy",
	"sessionDir",
] as const;

/** How deep a link may lead before the walk stops following it. */
const MOST_FOLDERS_DEEP = 24;

/** The file the pins are kept in, in the host's agent folder. */
export const PINS_FILE = "project-code.json";

/** A folder's code, as one digest over every file of it. */
export interface ProjectCode {
	/** What the code holds, by each file's place and contents. */
	readonly digest: string;
	/** Each file's place within the folder, for saying what changed. */
	readonly files: readonly string[];
	/** The newest time any file of it, or a link to one, changed status. */
	readonly newest: number;
}

/** Whether a folder's code may load, and why. */
export type CodeStanding =
	| { readonly kind: "none" }
	| { readonly kind: "pinned"; readonly code: ProjectCode }
	| { readonly kind: "unpinned"; readonly code: ProjectCode };

interface Pins {
	/** When the host first pinned anything: code older than this was there before it. */
	readonly since: number;
	readonly folders: Record<string, string>;
}

/**
 * The code `cwd`'s .pi holds, or undefined when it holds none. Links are
 * followed, since pi loads what they lead to, and the link itself counts
 * too, so a link moved to another file is a change.
 */
export function projectCode(cwd: string): ProjectCode | undefined {
	const base = join(cwd, ".pi");
	const lines: string[] = [];
	const files: string[] = [];
	let newest = 0;
	const take = (path: string, depth: number): void => {
		const own = lstatSync(path, { throwIfNoEntry: false });
		if (!own) return;
		const place = relative(cwd, path);
		newest = Math.max(newest, own.ctimeMs);
		if (own.isSymbolicLink()) lines.push(`link ${place} ${readlinkSync(path)}`);
		const seen = statSync(path, { throwIfNoEntry: false });
		if (!seen) return;
		newest = Math.max(newest, seen.ctimeMs);
		if (seen.isDirectory()) {
			if (depth >= MOST_FOLDERS_DEEP) {
				lines.push(`too-deep ${place}`);
				return;
			}
			const entries: Dirent[] = readdirSync(path, { withFileTypes: true });
			for (const name of entries.map((entry) => entry.name).sort())
				take(join(path, name), depth + 1);
			return;
		}
		if (!seen.isFile()) {
			lines.push(`other ${place}`);
			return;
		}
		const sum = createHash("sha256").update(readFileSync(path)).digest("hex");
		lines.push(`file ${place} ${sum}`);
		files.push(place);
	};
	for (const entry of CODE_ENTRIES) take(join(base, entry), 0);
	const settings = join(base, SETTINGS);
	const said = codeSettings(settings);
	if (said !== undefined) {
		const place = relative(cwd, settings);
		lines.push(`settings ${place} ${said}`);
		files.push(place);
		newest = Math.max(newest, statSync(settings).ctimeMs);
	}
	if (lines.length === 0) return undefined;
	const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
	return { digest, files, newest };
}

/**
 * The digest of the code settings `file` holds, or undefined when it
 * holds none. A file pi can't read as settings counts whole, since what
 * it would make of it can't be said.
 */
function codeSettings(file: string): string | undefined {
	if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
	const text = readFileSync(file);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.toString("utf8"));
	} catch {
		// Not settings pi can read: the whole file is what counts.
		return createHash("sha256").update(text).digest("hex");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		return createHash("sha256").update(text).digest("hex");
	const picked = CODE_SETTINGS.filter((key) => key in parsed).map((key) => [
		key,
		Reflect.get(parsed, key),
	]);
	if (picked.length === 0) return undefined;
	return createHash("sha256").update(JSON.stringify(picked)).digest("hex");
}

/**
 * Whether `cwd`'s code may load as it stands, by the pins in `agentDir`.
 * The first time the host looks at any folder, code or none, it starts
 * its pins, so code already there by then is pinned as found, and code
 * that comes after never is.
 */
export function codeStanding(
	cwd: string,
	agentDir: string,
	now: () => number = Date.now,
): CodeStanding {
	const file = join(agentDir, PINS_FILE);
	const pins = readPins(file) ?? writePins(file, { since: now(), folders: {} });
	const code = projectCode(cwd);
	if (!code) return { kind: "none" };
	if (pins.folders[cwd] === code.digest) return { kind: "pinned", code };
	if (code.newest < pins.since) {
		pin(cwd, agentDir, code);
		return { kind: "pinned", code };
	}
	return { kind: "unpinned", code };
}

/** Pin `code` as `cwd`'s, so it loads while it stays as it is. */
export function pin(cwd: string, agentDir: string, code: ProjectCode): void {
	const file = join(agentDir, PINS_FILE);
	const pins = readPins(file) ?? { since: Date.now(), folders: {} };
	writePins(file, {
		since: pins.since,
		folders: { ...pins.folders, [cwd]: code.digest },
	});
}

/** What to say of code that may not load, naming a few of its files. */
export function unpinnedSaying(cwd: string, code: ProjectCode): string {
	const named = code.files.slice(0, 3).join(", ");
	const more =
		code.files.length > 3 ? ` and ${code.files.length - 3} more` : "";
	const which = named ? ` (${named}${more})` : "";
	return `${cwd}'s .pi holds code pi would run outside the sandbox${which} that is new or changed since it was last allowed`;
}

function readPins(file: string): Pins | undefined {
	if (!existsSync(file)) return undefined;
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!isPins(parsed))
		throw new Error(`${file} isn't the host's project code pins`);
	return parsed;
}

function writePins(file: string, pins: Pins): Pins {
	// Written whole and renamed into place, so a reader never meets half of it.
	const staged = `${file}.${process.pid}.staged`;
	writeFileSync(staged, `${JSON.stringify(pins, null, "\t")}\n`, {
		mode: 0o600,
	});
	renameSync(staged, file);
	return pins;
}

function isPins(value: unknown): value is Pins {
	if (typeof value !== "object" || value === null) return false;
	if (!("since" in value && typeof value.since === "number")) return false;
	if (!("folders" in value)) return false;
	const { folders } = value;
	return (
		typeof folders === "object" &&
		folders !== null &&
		Object.values(folders).every((digest) => typeof digest === "string")
	);
}
