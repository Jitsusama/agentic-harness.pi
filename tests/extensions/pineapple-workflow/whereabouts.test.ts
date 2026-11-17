import {
	mkdtempSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createWhereabouts,
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

describe("createWhereabouts", () => {
	it("is the session's folder and the trees cut for it", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", { path: "/trees/mine", sessions: ["s1", "s2"] });
		record(cuts, "theirs.json", { path: "/trees/theirs", sessions: ["s3"] });
		record(cuts, "half.json", "{");
		writeFileSync(
			join(cuts, "mine.json.1.ab.tmp"),
			JSON.stringify({
				path: "/trees/staged",
				sessions: ["s1"],
			}),
		);
		expect(await createWhereabouts(cuts).dirsOf("s1", "/work/shop")).toEqual([
			"/work/shop",
			"/trees/mine",
		]);
	});

	it("is the session's folder alone when there are no records", async () => {
		const missing = join(cutsFolder(), "none");
		expect(await createWhereabouts(missing).dirsOf("s1", "/work/shop")).toEqual(
			["/work/shop"],
		);
	});

	it("doesn't read a record again while its file is unchanged", async () => {
		const cuts = cutsFolder();
		const file = join(cuts, "mine.json");
		writeFileSync(
			file,
			JSON.stringify({ path: "/trees/mine", sessions: ["s1"] }),
		);
		// A whole second, so the time put back below is the same to the last bit.
		const then = 1_700_000_000;
		utimesSync(file, then, then);
		const where = createWhereabouts(cuts);
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		// The same file, its bytes changed in place and its times put back:
		// only a read would see the new holder.
		writeFileSync(
			file,
			JSON.stringify({ path: "/trees/mine", sessions: ["s9"] }),
		);
		utimesSync(file, then, then);
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("doesn't look at the records while their folder is settled and unchanged", async () => {
		const cuts = cutsFolder();
		const file = join(cuts, "mine.json");
		writeFileSync(
			file,
			JSON.stringify({ path: "/trees/mine", sessions: ["s1"] }),
		);
		// Last changed long ago, as a folder nobody has cut a tree in lately.
		const then = 1_700_000_000;
		utimesSync(cuts, then, then);
		const where = createWhereabouts(cuts);
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		// Written in place, which the work tool never does, so only a look at
		// the record itself would see it; the folder says nothing changed.
		writeFileSync(
			file,
			JSON.stringify({ path: "/trees/mine", sessions: ["s9"] }),
		);
		utimesSync(cuts, then, then);
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("looks at the records again while their folder has only just changed", async () => {
		const cuts = cutsFolder();
		const file = join(cuts, "mine.json");
		writeFileSync(
			file,
			JSON.stringify({ path: "/trees/mine", sessions: ["s1"] }),
		);
		const where = createWhereabouts(cuts);
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		// Written in place, so the folder's stamp stays as a rename in the
		// same tick leaves it; the folder is too fresh to trust it.
		writeFileSync(
			file,
			JSON.stringify({ path: "/trees/mine", sessions: ["s9"] }),
		);
		expect(await where.dirsOf("s9", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("reads a record again once it is rewritten", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", { path: "/trees/mine", sessions: ["s1"] });
		const where = createWhereabouts(cuts);
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		record(cuts, "mine.json", { path: "/trees/mine", sessions: ["s2"] });
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work"]);
		expect(await where.dirsOf("s2", "/work")).toEqual(["/work", "/trees/mine"]);
	});

	it("forgets a record once its file is gone", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", { path: "/trees/mine", sessions: ["s1"] });
		const where = createWhereabouts(cuts);
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
		rmSync(join(cuts, "mine.json"));
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work"]);
	});

	it("takes a half-written record once it is whole", async () => {
		const cuts = cutsFolder();
		record(cuts, "mine.json", "{");
		const where = createWhereabouts(cuts);
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work"]);
		record(cuts, "mine.json", { path: "/trees/mine", sessions: ["s1"] });
		expect(await where.dirsOf("s1", "/work")).toEqual(["/work", "/trees/mine"]);
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
