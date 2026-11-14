import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	dirsOf,
	reposOf,
} from "../../../extensions/pineapple-workflow/whereabouts.ts";

describe("dirsOf", () => {
	it("is the session's folder and the trees cut for it", () => {
		const cuts = mkdtempSync(join(tmpdir(), "pineapple-cuts-"));
		writeFileSync(
			join(cuts, "mine.json"),
			JSON.stringify({ path: "/trees/mine", sessions: ["s1", "s2"] }),
		);
		writeFileSync(
			join(cuts, "theirs.json"),
			JSON.stringify({ path: "/trees/theirs", sessions: ["s3"] }),
		);
		writeFileSync(join(cuts, "half.json"), "{");
		expect(dirsOf("s1", "/work/shop", cuts)).toEqual([
			"/work/shop",
			"/trees/mine",
		]);
		expect(dirsOf("s1", "/work/shop", join(cuts, "none"))).toEqual([
			"/work/shop",
		]);
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
