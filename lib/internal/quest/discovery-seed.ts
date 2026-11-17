/**
 * The seed quest discovery leaves for the next process: what one
 * process's memo learned of a quest tree, written to the cache folder so
 * the next process's first walk need not read and parse every file
 * again. `discovery.ts` takes a seed before its first walk of a root and
 * leaves one after a walk that parsed many files.
 */

import { createHash } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "node:v8";
import type { QuestDoc, QuestDocumentDoc } from "../../quest/types.ts";
import { kept, memo, type Parsed } from "./discovery-reads.ts";

/** Where discovery keeps what it learned, for the next process. */
export interface SeedOptions {
	/** The folder seeds are kept in, or null to keep none. */
	readonly dir?: string | null;
	/** How many files a walk must parse before its seed is written. */
	readonly after?: number;
	/** The version of the code a seed is kept for: by default, this code's own hash. */
	readonly code?: string;
}

/**
 * What one process learned of a quest tree, left for the next: each
 * file's content hash under the stat it was taken at, and each README's
 * and document's front matter and title under the hash it was parsed
 * from.
 *
 * A process's memo starts empty, and so does one a reload clears, so
 * its first walk read and parsed every file: 17.2 s at CPU pressure 76%
 * on 30 October, over 772 quests and 1,517 documents, paid by every
 * start and by each of 40 sessions at once after every install. Taken
 * from a seed, a file is read only when its stat no longer matches, and
 * parsed only when its hash doesn't, the checks the memo already makes.
 * The seed carries the hash of the code that parsed it, so a change to
 * the parsing never meets a record shaped by the old one.
 */
interface Seed {
	readonly v: typeof SEED_VERSION;
	readonly code: string;
	readonly root: string;
	readonly stamps: [path: string, stat: string, hash: string][];
	readonly records: Record<"readmes" | "documents", SeedRecord[]>;
}

/** A parsed file as a seed keeps it. */
type SeedRecord = [
	path: string,
	hash: string,
	frontMatter: unknown,
	title: string | undefined,
];

const SEED_VERSION = 1;

/** The cache folder seeds go in. */
export const SEED_FOLDER = "quest-discovery";

/**
 * How many files a walk must have parsed before it leaves a seed. After
 * one journal line every session reparses one README, and writing the
 * seed for that would rewrite megabytes forty times over; a seed a few
 * files behind costs its reader a few parses.
 */
export const SEED_AFTER_PARSES = 50;

/**
 * How long another version's seed is kept after it was last left. A
 * version still running leaves its seed again after any walk that
 * parses much, so one left alone this long belongs to code nothing
 * runs, and costs megabytes of disk for nothing.
 */
const SEED_KEPT_MS = 24 * 60 * 60 * 1000;

/** The start of every seed file's name for `questsRoot`. */
function seedStem(questsRoot: string): string {
	return createHash("sha1").update(questsRoot).digest("hex").slice(0, 16);
}

/**
 * The seed for `questsRoot` as `code` reads it. Each version of the
 * code keeps its own, because sessions on several installs run at once
 * and each rejects a seed another version left.
 */
function seedFile(questsRoot: string, dir: string, code: string): string {
	return join(dir, `${seedStem(questsRoot)}-${code.slice(0, 12)}.v8`);
}

/** Remove the seeds for `questsRoot` that no version has left for a day. */
function clearStaleSeeds(questsRoot: string, dir: string, kept: string): void {
	const stem = seedStem(questsRoot);
	const before = Date.now() - SEED_KEPT_MS;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		// No folder to list: there is nothing in it to clear.
		return;
	}
	for (const name of names) {
		const path = join(dir, name);
		if (!name.startsWith(stem) || path === kept) continue;
		try {
			if (statSync(path).mtimeMs < before) unlinkSync(path);
		} catch {
			// Gone already, or another process is clearing it: either way the
			// next seed left tries again.
		}
	}
}

function isSeedRecord(value: unknown): value is SeedRecord {
	return (
		Array.isArray(value) &&
		typeof value[0] === "string" &&
		typeof value[1] === "string" &&
		typeof value[2] === "object" &&
		value[2] !== null &&
		(value[3] === undefined || typeof value[3] === "string")
	);
}

function isSeed(value: unknown): value is Seed {
	if (typeof value !== "object" || value === null) return false;
	const seed = value as Partial<Seed>;
	return (
		seed.v === SEED_VERSION &&
		typeof seed.code === "string" &&
		typeof seed.root === "string" &&
		Array.isArray(seed.stamps) &&
		seed.stamps.every(
			(s) => Array.isArray(s) && s.every((part) => typeof part === "string"),
		) &&
		Array.isArray(seed.records?.readmes) &&
		seed.records.readmes.every(isSeedRecord) &&
		Array.isArray(seed.records?.documents) &&
		seed.records.documents.every(isSeedRecord)
	);
}

/** Fill a fresh memo for `questsRoot` from its seed, once per memo. */
export function takeSeed(questsRoot: string, dir: string, code: string): void {
	const m = memo();
	if (m.seeded.has(questsRoot)) return;
	m.seeded.add(questsRoot);
	let seed: unknown;
	try {
		seed = deserialize(readFileSync(seedFile(questsRoot, dir, code)));
	} catch {
		// No seed yet, or one cut short: the walk reads everything, as it
		// did before seeds, and leaves one.
		return;
	}
	if (!isSeed(seed) || seed.code !== code || seed.root !== questsRoot) {
		return;
	}
	for (const [path, stat, hash] of seed.stamps) {
		if (!m.stamps.has(path)) m.stamps.set(path, { stat, hash });
	}
	for (const [path, hash, frontMatter, title] of seed.records.readmes) {
		if (m.readmes.has(path)) continue;
		const doc = kept<QuestDoc>(
			{ frontMatter: frontMatter as QuestDoc["frontMatter"], title },
			path,
		);
		m.readmes.set(path, { hash, doc });
	}
	for (const [path, hash, frontMatter, title] of seed.records.documents) {
		if (m.documents.has(path)) continue;
		const doc = kept<QuestDocumentDoc>(
			{ frontMatter: frontMatter as QuestDocumentDoc["frontMatter"], title },
			path,
		);
		m.documents.set(path, { hash, doc });
	}
}

/** Write what the memo holds of `questsRoot` as its seed. */
export function leaveSeed(questsRoot: string, dir: string, code: string): void {
	const m = memo();
	const under = (path: string) => path.startsWith(questsRoot + sep);
	const records = <D extends QuestDoc | QuestDocumentDoc>(
		table: Map<string, Parsed<D>>,
	): SeedRecord[] =>
		[...table]
			.filter(([path]) => under(path))
			.map(([path, { hash, doc }]) => [path, hash, doc.frontMatter, doc.title]);
	const seed: Seed = {
		v: SEED_VERSION,
		code,
		root: questsRoot,
		stamps: [...m.stamps]
			.filter(([path]) => under(path))
			.map(([path, { stat, hash }]) => [path, stat, hash]),
		records: {
			readmes: records(m.readmes),
			documents: records(m.documents),
		},
	};
	const file = seedFile(questsRoot, dir, code);
	const draft = `${file}.${process.pid}.tmp`;
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(draft, serialize(seed));
		renameSync(draft, file);
	} catch {
		// A seed that can't be written leaves the next process to walk
		// everything, which is all it costs.
		return;
	}
	clearStaleSeeds(questsRoot, dir, file);
}

let code: string | undefined;

/**
 * A hash of the code that shapes a parsed record: every module beside
 * this one and the version of the YAML parser they use.
 */
export function codeKey(): string {
	if (code) return code;
	const hash = createHash("sha1");
	const here = dirname(fileURLToPath(import.meta.url));
	const names = readdirSync(here, { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".ts"))
		.sort();
	for (const name of names) {
		hash.update(name);
		hash.update(readFileSync(join(here, name)));
	}
	try {
		const yaml: unknown = createRequire(import.meta.url)("yaml/package.json");
		hash.update(JSON.stringify(yaml));
	} catch {
		// No version to read: the sources alone still key the seed.
	}
	code = hash.digest("hex");
	return code;
}
