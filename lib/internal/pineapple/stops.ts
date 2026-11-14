/**
 * The stops Joel's safe word has made, as the pineapple reader in core
 * writes them: one JSON file each under `$XDG_STATE_HOME/pineapple/stops/`,
 * written whole and renamed into place, standing until Joel resumes it.
 *
 * Nothing here decides what a stop reaches. The reader did that from the
 * words and where they were said, and wrote it down as `reaches`; this
 * only reads those back. A reach this package doesn't know is read as
 * everything, since a stop that reaches too much costs a pause Joel
 * lifts, and one that reaches too little costs someone else's work.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What one stop reaches, as its record names it. */
export type Reach =
	| { readonly kind: "everything" }
	| { readonly kind: "realm"; readonly name: string }
	| {
			readonly kind: "pr";
			readonly repo?: string;
			readonly number: number;
	  }
	| { readonly kind: "branch"; readonly repo?: string; readonly name: string }
	| { readonly kind: "repo"; readonly repo: string }
	| { readonly kind: "quest"; readonly id: string }
	| { readonly kind: "named"; readonly name: string };

/** A stop that stands: nobody has resumed it. */
export interface Stop {
	readonly id: string;
	/** Only written down: nothing acts on it but to say what it would do. */
	readonly shadow: boolean;
	readonly saidBy?: string;
	readonly where?: string;
	readonly words?: string;
	readonly reaches: readonly Reach[];
}

/** The stops standing, and the records that couldn't be read. */
export interface Standing {
	readonly stops: readonly Stop[];
	readonly unreadable: readonly string[];
}

/** Where the reader keeps its stops, by the XDG state folder. */
export function stopsFolder(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
): string {
	const state = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
	return join(state, "pineapple", "stops");
}

/** One reach from the text a record gives it, such as `pr:owner/name#12`. */
export function reachOf(text: string): Reach {
	const colon = text.indexOf(":");
	const kind = colon < 0 ? text : text.slice(0, colon);
	const rest = colon < 0 ? "" : text.slice(colon + 1);
	switch (kind) {
		case "realm":
			return rest ? { kind, name: rest } : EVERYTHING;
		case "pr": {
			const hash = rest.lastIndexOf("#");
			const number = Number(rest.slice(hash + 1));
			if (hash < 0 || !Number.isInteger(number) || number <= 0) {
				return EVERYTHING;
			}
			const repo = repoName(rest.slice(0, hash));
			return repo ? { kind, repo, number } : { kind, number };
		}
		case "branch": {
			const at = rest.lastIndexOf("@");
			const name = rest.slice(at + 1);
			if (!name) return EVERYTHING;
			const repo = repoName(rest.slice(0, Math.max(at, 0)));
			return repo ? { kind, repo, name } : { kind, name };
		}
		case "repo": {
			const repo = repoName(rest);
			return repo ? { kind, repo } : EVERYTHING;
		}
		case "quest":
			return rest ? { kind, id: rest.toUpperCase() } : EVERYTHING;
		case "named":
			return rest ? { kind, name: rest.toLowerCase() } : EVERYTHING;
		default:
			return EVERYTHING;
	}
}

/**
 * A stop from its record, or undefined when it has been resumed. A
 * record that names no reach at all reaches everything, like a reach
 * this package can't read.
 */
export function stopOf(record: unknown, id: string): Stop | undefined {
	if (typeof record !== "object" || record === null) return undefined;
	const fields = record as Record<string, unknown>;
	if (fields.resumed !== undefined && fields.resumed !== null) return undefined;
	const reaches = Array.isArray(fields.reaches)
		? fields.reaches.filter((r) => typeof r === "string").map(reachOf)
		: [];
	return {
		id: typeof fields.id === "string" ? fields.id : id,
		// Only a record saying plainly that it is live is enforced; one
		// that says nothing is from a reader still in shadow.
		shadow: fields.shadow !== false,
		saidBy: text(fields.said_by),
		where: text(fields.where),
		words: text(fields.words),
		reaches: reaches.length > 0 ? reaches : [EVERYTHING],
	};
}

/** Every stop standing in `folder`; none when the reader has made none. */
export function standingStops(folder: string = stopsFolder()): Standing {
	let names: string[];
	try {
		names = readdirSync(folder).filter((name) => name.endsWith(".json"));
	} catch {
		// No folder: the reader has never stopped anything.
		return { stops: [], unreadable: [] };
	}
	const stops: Stop[] = [];
	const unreadable: string[] = [];
	for (const name of names.sort()) {
		try {
			const stop = stopOf(
				JSON.parse(readFileSync(join(folder, name), "utf8")),
				name.slice(0, -".json".length),
			);
			if (stop) stops.push(stop);
		} catch {
			unreadable.push(name);
		}
	}
	return { stops, unreadable };
}

/** How a reach reads to a person, as the record wrote it. */
export function describeReach(reach: Reach): string {
	switch (reach.kind) {
		case "everything":
			return "everything";
		case "realm":
			return `the ${reach.name} realm`;
		case "pr":
			return `${reach.repo ?? ""}#${reach.number}`;
		case "branch":
			return `branch ${reach.name}${reach.repo ? ` of ${reach.repo}` : ""}`;
		case "repo":
			return reach.repo;
		case "quest":
			return reach.id;
		case "named":
			return `"${reach.name}"`;
	}
}

const EVERYTHING: Reach = { kind: "everything" };

/** A repository's `owner/name`, lowercased, or undefined for none. */
function repoName(text: string): string | undefined {
	const trimmed = text.trim().toLowerCase();
	return trimmed === "" ? undefined : trimmed;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}
