import {
	mkdtempSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createWhereabouts,
	type Disk,
	reposOf,
} from "../../../extensions/pineapple-workflow/whereabouts.ts";

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

/** The real disk, watched: what it was asked, and what it is told to do. */
function watchedDisk() {
	const seen = { listings: 0, reads: [] as string[] };
	const hidden = new Set<string>();
	const failing = new Set<string>();
	let hanging = false;
	const disk: Partial<Disk> = {
		async list(dir) {
			seen.listings += 1;
			if (hanging) return new Promise<string[]>(() => undefined);
			return (await readdir(dir)).filter((name) => !hidden.has(name));
		},
		async read(path) {
			seen.reads.push(basename(path));
			if (failing.has(basename(path))) {
				throw Object.assign(new Error("a stalled disk"), { code: "EIO" });
			}
			return readFile(path, "utf8");
		},
	};
	return {
		disk,
		seen,
		hidden,
		failing,
		hang() {
			hanging = true;
		},
	};
}

/** A clock standing `ms` after the folder last changed. */
function sinceChanged(cuts: string, ms: number): () => number {
	return () => statSync(cuts).mtimeMs + ms;
}

describe("createWhereabouts", () => {
	it("is the session's folder and the trees cut for it", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", { path: "/trees/mine", sessions: ["s1", "s2"] });
		record(cuts, "theirs.json", { path: "/trees/theirs", sessions: ["s3"] });
		record(cuts, "half.json", "{");
		writeFileSync(join(cuts, "mine.json.1.ab.tmp"), JSON.stringify(mine("s1")));
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
			now: sinceChanged(cuts, 0),
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
		const where = createWhereabouts(cuts, {
			disk: watched.disk,
			now: sinceChanged(cuts, 5_000),
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
		const where = createWhereabouts(cuts);
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		record(cuts, "mine.json", mine("s2"));
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work"]);
		expect(await where.dirsOf("s2", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("forgets a record once its file is gone", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const where = createWhereabouts(cuts);
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		rmSync(join(cuts, "mine.json"));
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work"]);
	});

	it("takes a broken record once it is written whole", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", "{");
		const where = createWhereabouts(cuts);
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work"]);
		record(cuts, "mine.json", mine("s1"));
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("keeps a record a listing missed while its file is there", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		const where = createWhereabouts(cuts, { disk: watched.disk });
		await where.dirsOf("s1", "/work");
		// As btrfs can leave out a record being renamed over itself.
		watched.hidden.add("mine.json");
		record(cuts, "other.json", mine("s9"));
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		rmSync(join(cuts, "mine.json"));
		record(cuts, "another.json", mine("s9"));
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work"]);
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
		watched.failing.add("mine.json");
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		// The folder hasn't changed since, but the pass that failed isn't
		// trusted, so the next one looks again.
		watched.failing.clear();
		expect(await where.dirsOf("s2", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("answers from what it knew when a pass outlasts its patience", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", mine("s1"));
		const watched = watchedDisk();
		const where = createWhereabouts(cuts, {
			disk: watched.disk,
			patienceMs: 20,
		});
		await where.dirsOf("s1", "/work");
		watched.hang();
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
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

	it("reads more records than it reads at once", async () => {
		const cuts = cutsFolder();
		const many = 100;
		for (let one = 0; one < many; one += 1) {
			record(cuts, `t${one}.json`, {
				path: `/trees/t${one}`,
				sessions: ["s1"],
			});
		}
		const dirs = await createWhereabouts(cuts).dirsOf("s1", "/work");
		expect(dirs).toHaveLength(many + 1);
		expect(dirs).toContain(`/trees/t${many - 1}`);
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
