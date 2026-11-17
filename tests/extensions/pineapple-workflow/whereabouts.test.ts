import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createGate,
	createWhereabouts as createHostWhereabouts,
	type Disk,
	reposOf,
	type Whereabouts,
	type WhereaboutsOptions,
} from "../../../extensions/pineapple-workflow/whereabouts.ts";

/**
 * Whereabouts with a bound on the disk of their own, so a case that
 * stalls its disk holds no other case's turns.
 */
function createWhereabouts(
	cuts: string,
	options: WhereaboutsOptions = {},
): Whereabouts {
	return createHostWhereabouts(cuts, { gate: createGate(), ...options });
}

/** A folder of work records, empty. */
function cutsFolder(): string {
	return mkdtempSync(join(tmpdir(), "pineapple-cuts-"));
}

/** A record written as the work tool writes one: beside, then renamed in. */
function record(cuts: string, name: string, body: unknown): void {
	const staging = join(cuts, `${name}.staging.tmp`);
	writeFileSync(
		staging,
		typeof body === "string" ? body : JSON.stringify(body),
	);
	renameSync(staging, join(cuts, name));
}

/** The tree `mine.json` names, held by `holder`. */
function mine(holder: string): unknown {
	return { path: "/trees/mine", sessions: [holder] };
}

/**
 * The folder's times moved on two seconds, as the kernel's next tick
 * would leave them after a change: a rename within one tick leaves them
 * as they were, which only the settling rule answers for.
 */
function ticked(cuts: string): void {
	const was = statSync(cuts).mtimeMs;
	const next = new Date(was + 2_000);
	utimesSync(cuts, next, next);
}

/** A clock standing `ms` after the folder last changed. */
function sinceChanged(cuts: string, ms: number): () => number {
	return () => statSync(cuts).mtimeMs + ms;
}

/** A clock under which the folder has always only just changed. */
function fresh(cuts: string): { now: () => number } {
	return { now: sinceChanged(cuts, 0) };
}

/** An error as a stalled disk gives one. */
function stalled(): Error {
	return Object.assign(new Error("a stalled disk"), { code: "EIO" });
}

/** The real disk, watched: what it was asked, and what it is told to do. */
function watchedDisk() {
	const seen = { listings: 0, reads: [] as string[], mostAtOnce: 0 };
	const hidden = new Set<string>();
	const failing = new Set<string>();
	const unstamped = new Set<string>();
	const notPlain = new Set<string>();
	const how = { hanging: false, listingFails: false, listingTakes: 0 };
	let calling = 0;
	/** `work`, counted among the calls under way while it runs. */
	async function counted<T>(work: () => Promise<T>): Promise<T> {
		calling += 1;
		seen.mostAtOnce = Math.max(seen.mostAtOnce, calling);
		try {
			return await work();
		} finally {
			calling -= 1;
		}
	}
	const disk: Partial<Disk> = {
		async list(dir) {
			seen.listings += 1;
			if (how.hanging) return new Promise<string[]>(() => undefined);
			if (how.listingFails) throw stalled();
			if (how.listingTakes > 0) {
				// A disk as slow as the case needs, past the patience it sets.
				await new Promise((done) => setTimeout(done, how.listingTakes));
			}
			return (await readdir(dir)).filter((name) => !hidden.has(name));
		},
		stamp: (path) =>
			counted(async () => {
				if (unstamped.has(basename(path))) throw stalled();
				const now = await stat(path);
				return {
					stamp: `${now.ino}:${now.mtimeMs}:${now.ctimeMs}:${now.size}`,
					changed: now.mtimeMs,
				};
			}),
		read: (path) =>
			counted(async () => {
				seen.reads.push(basename(path));
				if (failing.has(basename(path))) throw stalled();
				// Long enough that reads let run together overlap, so the
				// count of calls at once sees every one.
				await new Promise((done) => setTimeout(done, 5));
				if (notPlain.has(basename(path))) return undefined;
				return await readFile(path, "utf8");
			}),
	};
	return { disk, seen, hidden, failing, unstamped, notPlain, how };
}

describe("createWhereabouts", () => {
	it("is the session's folder and the trees cut for it", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", { path: "/trees/mine", sessions: ["s1", "s2"] });
		record(cuts, "theirs.json", { path: "/trees/theirs", sessions: ["s3"] });
		record(cuts, "half.json", "{");
		record(cuts, "pathless.json", { path: 5, sessions: ["s1"] });
		record(cuts, "lone.json", { path: "/trees/lone", sessions: "s1" });
		writeFileSync(
			join(cuts, "mine.json.1.ab.tmp"),
			JSON.stringify({ path: "/trees/staging", sessions: ["s1"] }),
		);
		expect(await createWhereabouts(cuts).dirsOf("s1", "/work")).toEqual([
			"/work",
			"/trees/mine",
		]);
	});

	it("is the session's folder alone when there are no records", async () => {
		const missing = join(cutsFolder(), "none");
		expect(await createWhereabouts(missing).dirsOf("s1", "/work")).toEqual([
			"/work",
		]);
	});

	it("doesn't read a record again while its file is unchanged", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		// Fresh, so every pass lists the folder and looks at each record.
		const where = createWhereabouts(cuts, {
			disk: watched.disk,
			...fresh(cuts),
		});
		await where.dirsOf("s1", "/work");
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		expect(watched.seen.listings).toBe(2);
		expect(watched.seen.reads).toEqual(["mine.json"]);
	});

	it("doesn't list a folder settled and unchanged since it was listed", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		// Settled from the very tick the settling rule names.
		const where = createWhereabouts(cuts, {
			disk: watched.disk,
			now: sinceChanged(cuts, 1_000),
		});
		await where.dirsOf("s1", "/work");
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		expect(watched.seen.listings).toBe(1);
	});

	it("lists a settled folder again once a record is renamed into it", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		// Long after anything the case does, so every listing is trusted.
		const later = statSync(cuts).mtimeMs + 60_000;
		const where = createWhereabouts(cuts, { now: () => later });
		expect(await where.dirsOf("s2", "/work")).toEqual(["/work"]);
		record(cuts, "theirs.json", { path: "/trees/theirs", sessions: ["s2"] });
		ticked(cuts);
		expect(await where.dirsOf("s2", "/work")).toEqual([
			"/work",
			"/trees/theirs",
		]);
	});

	it("lists a folder that has only just changed though its stamp hasn't", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		// As a rename in the same tick as the stamp would leave it.
		const where = createWhereabouts(cuts, {
			disk: watched.disk,
			now: sinceChanged(cuts, 999),
		});
		await where.dirsOf("s1", "/work");
		await where.dirsOf("s1", "/work");
		expect(watched.seen.listings).toBe(2);
	});

	it("reads a record again once it is rewritten", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const where = createWhereabouts(cuts, fresh(cuts));
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		record(cuts, "mine.json", mine("s2"));
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work"]);
		expect(await where.dirsOf("s2", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("forgets a record once its file is gone", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const where = createWhereabouts(cuts, fresh(cuts));
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		rmSync(join(cuts, "mine.json"));
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work"]);
	});

	it("takes a broken record once it is written whole", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", "{");
		const where = createWhereabouts(cuts, fresh(cuts));
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work"]);
		record(cuts, "mine.json", mine("s1"));
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("keeps a record a listing missed while its file is there", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		const where = createWhereabouts(cuts, {
			disk: watched.disk,
			...fresh(cuts),
		});
		await where.dirsOf("s1", "/work");
		// As btrfs can leave out a record being renamed over itself.
		watched.hidden.add("mine.json");
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		rmSync(join(cuts, "mine.json"));
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work"]);
	});

	it("doesn't read a record that isn't a plain file", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		// As a pipe would stand, whose reading waits on a writer for good.
		record(cuts, "pipe.json", { path: "/trees/pipe", sessions: ["s1"] });
		const watched = watchedDisk();
		watched.notPlain.add("pipe.json");
		const where = createWhereabouts(cuts, { disk: watched.disk });
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("never waits on a pipe in a record's place", {
		timeout: 2_000,
	}, async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		// A pipe with no writer, whose reading would wait for good.
		execFileSync("mkfifo", [join(cuts, "pipe.json")]);
		expect(await createWhereabouts(cuts).dirsOf("s1", "/work")).toEqual([
			"/work",
			"/trees/mine",
		]);
	});

	it("keeps what it knew of a record the disk fails to read, and reads it again", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		const later = statSync(cuts).mtimeMs + 60_000;
		const where = createWhereabouts(cuts, {
			disk: watched.disk,
			now: () => later,
		});
		await where.dirsOf("s1", "/work");
		record(cuts, "mine.json", mine("s2"));
		ticked(cuts);
		watched.failing.add("mine.json");
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		// The folder hasn't changed since, but the pass that failed isn't
		// trusted, so the next one looks again.
		watched.failing.clear();
		expect(await where.dirsOf("s2", "/work")).toEqual(["/work", "/trees/mine"]);
		expect(watched.seen.reads).toEqual(["mine.json", "mine.json", "mine.json"]);
	});

	it("keeps what it knew of a record the disk fails to stamp, and looks again", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		const later = statSync(cuts).mtimeMs + 60_000;
		const where = createWhereabouts(cuts, {
			disk: watched.disk,
			now: () => later,
		});
		await where.dirsOf("s1", "/work");
		ticked(cuts);
		watched.unstamped.add("mine.json");
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		// Written in place, which leaves the folder as it was: only a pass
		// that distrusts the failed one sees it.
		watched.unstamped.clear();
		// A new size, so the record's own stamp moves however coarse its
		// times are.
		writeFileSync(
			join(cuts, "mine.json"),
			JSON.stringify({ path: "/trees/mine", sessions: ["s2", "s3"] }),
		);
		expect(await where.dirsOf("s2", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("keeps what it knew when the disk fails to list, and lists again", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		const later = statSync(cuts).mtimeMs + 60_000;
		const where = createWhereabouts(cuts, {
			disk: watched.disk,
			now: () => later,
		});
		await where.dirsOf("s1", "/work");
		ticked(cuts);
		watched.how.listingFails = true;
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		watched.how.listingFails = false;
		await where.dirsOf("s1", "/work");
		expect(watched.seen.listings).toBe(3);
	});

	it("waits for a pass however long it takes until one is whole", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		watched.how.listingFails = true;
		const where = createWhereabouts(cuts, {
			disk: watched.disk,
			patienceMs: 10,
		});
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work"]);
		watched.how.listingFails = false;
		watched.how.listingTakes = 100;
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("waits for its first pass however long it takes", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		watched.how.listingTakes = 100;
		const where = createWhereabouts(cuts, {
			disk: watched.disk,
			patienceMs: 10,
		});
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("answers from what it knew when a later pass outlasts its patience", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		const where = createWhereabouts(cuts, {
			disk: watched.disk,
			patienceMs: 20,
			...fresh(cuts),
		});
		await where.dirsOf("s1", "/work");
		watched.how.hanging = true;
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("waits on a stuck pass once, not once for each asker", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		let clock = 0;
		const patienceMs = 50;
		const where = createWhereabouts(cuts, {
			disk: watched.disk,
			patienceMs,
			now: () => clock,
		});
		await where.dirsOf("s1", "/work");
		watched.how.hanging = true;
		await where.dirsOf("s1", "/work");
		clock += patienceMs;
		const marker = new Promise<string>((done) =>
			setTimeout(() => done("waited"), patienceMs / 2),
		);
		const answer = where.dirsOf("s1", "/work").then(() => "answered");
		expect(await Promise.race([answer, marker])).toBe("answered");
		expect(watched.seen.listings).toBe(2);
	});

	it("runs one pass for askers who ask at once", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		const where = createWhereabouts(cuts, { disk: watched.disk });
		const both = await Promise.all([
			where.dirsOf("s1", "/work"),
			where.dirsOf("s1", "/work"),
		]);
		expect(both).toEqual([
			["/work", "/trees/mine"],
			["/work", "/trees/mine"],
		]);
		expect(watched.seen.listings).toBe(1);
	});

	it("reads more records than it reads at once, two at a time", async () => {
		const cuts = cutsFolder();
		const many = 100;
		for (let one = 0; one < many; one += 1) {
			record(cuts, `t${one}.json`, {
				path: `/trees/t${one}`,
				sessions: ["s1"],
			});
		}
		const watched = watchedDisk();
		const dirs = await createWhereabouts(cuts, { disk: watched.disk }).dirsOf(
			"s1",
			"/work",
		);
		expect(dirs).toHaveLength(many + 1);
		expect(dirs).toContain(`/trees/t${many - 1}`);
		expect(watched.seen.mostAtOnce).toBe(2);
	});

	it("reads two at a time over every conversation on the host", async () => {
		const cuts = cutsFolder();
		for (let one = 0; one < 20; one += 1) {
			record(cuts, `t${one}.json`, {
				path: `/trees/t${one}`,
				sessions: ["s1"],
			});
		}
		const watched = watchedDisk();
		// The host's own bound, as each conversation takes it.
		const first = createHostWhereabouts(cuts, { disk: watched.disk });
		const second = createHostWhereabouts(cuts, { disk: watched.disk });
		await Promise.all([
			first.dirsOf("s1", "/work"),
			second.dirsOf("s1", "/work"),
		]);
		expect(watched.seen.mostAtOnce).toBe(2);
	});
});

describe("reposOf", () => {
	it("is each folder's repository, once, leaving out the unknown", async () => {
		const repos = await reposOf(["/a", "/b", "/c"], async (dir) =>
			dir === "/c" ? undefined : "example/shop",
		);
		expect(repos).toEqual(["example/shop"]);
	});
});
