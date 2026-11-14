/**
 * What the fence's own homes for programs (`fence-home.ts`'s `OWN_HOMES`)
 * start with: copies of what the person's own already downloaded, so a
 * fenced `cargo --offline` finds the crates the person's cargo fetched
 * (5GLTPH, 13 November: `cargo clippy --offline` missed itoa 1.0.19).
 * Copies flow one way, from the person's home into the fence's, by
 * reflink where the disk can, so they cost no space until one side
 * changes; nothing written inside reaches the person's home.
 */

import { randomUUID } from "node:crypto";
import { constants, promises as disk } from "node:fs";
import { join } from "node:path";

/**
 * What each own home is seeded with, by its folder in the sandbox's
 * cache: the person's folder, from the home folder, and where it goes
 * in the own home. Only what was downloaded and is checked against a
 * sum before use: cargo's crate archives, its index and its git
 * dependencies' bare clones. Never `registry/src`, the unpacked crates,
 * which the fenced cargo unpacks for itself.
 */
export const SEEDS = [
	{ home: "cargo", from: ".cargo/registry/cache", to: "registry/cache" },
	{ home: "cargo", from: ".cargo/registry/index", to: "registry/index" },
	{ home: "cargo", from: ".cargo/git/db", to: "git/db" },
] as const;

/**
 * How long a seeding stands before the next command seeds again, so a
 * crate the person's cargo fetched reaches the fence within it, while a
 * session running many commands walks the person's registry once.
 */
const SEEDED_FOR_MS = 10 * 60 * 1000;

/** When each own home was last seeded, by its sandbox cache folder. */
const seededAt = new Map<string, number>();

/**
 * Seed the own homes in the sandbox cache `own` from the home folder
 * `home`, unless they were seeded within `SEEDED_FOR_MS` of `now`. It
 * never waits on the disk before answering: the promise, or nothing
 * when it was seeded too recently, settles once every copy is made,
 * and never rejects. A command started before it settles finds what
 * the own home held already, as it did before seeding.
 */
export function seedOwnHomes(
	home: string,
	own: string,
	now: number = Date.now(),
): Promise<void> | undefined {
	const last = seededAt.get(own);
	if (last !== undefined && now - last < SEEDED_FOR_MS) return undefined;
	seededAt.set(own, now);
	return Promise.all(
		SEEDS.map((seed) =>
			copyMissing(join(home, seed.from), join(own, seed.home, seed.to)),
		),
	).then(() => undefined);
}

/**
 * Copy every file under `from` that `to` lacks, keeping what `to`
 * holds already, since the fenced program may have fetched a newer one.
 * A link is left out, so nothing outside the person's folder is read
 * by following one. Each copy is made beside its place and linked in,
 * so a fenced program never reads one half written, and two sessions
 * seeding at once each keep whichever arrived first.
 */
async function copyMissing(from: string, to: string): Promise<void> {
	const entries = await disk
		.readdir(from, { withFileTypes: true })
		.catch(() => undefined);
	if (entries === undefined) return;
	try {
		await disk.mkdir(to, { recursive: true, mode: 0o700 });
	} catch {
		// A folder that can't be made leaves the own home as it was: the
		// fenced program fetches what it lacks, as it did before seeding.
		return;
	}
	for (const entry of entries) {
		const source = join(from, entry.name);
		const place = join(to, entry.name);
		if (entry.isDirectory()) await copyMissing(source, place);
		else if (entry.isFile()) await copyOne(source, place, entry.name, to);
	}
}

/** Copy the file `source` to `place` in the folder `to`, unless one is there. */
async function copyOne(
	source: string,
	place: string,
	name: string,
	to: string,
): Promise<void> {
	if (await disk.lstat(place).catch(() => undefined)) return;
	const half = join(to, `.${name}.seeding-${randomUUID()}`);
	try {
		await disk.copyFile(
			source,
			half,
			constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
		);
		await disk.link(half, place);
	} catch {
		// A file another session seeded first, or one that vanished or
		// couldn't be read, is left as it stands: the fenced program
		// fetches what it lacks, as it did before seeding.
	}
	await disk.rm(half, { force: true });
}
