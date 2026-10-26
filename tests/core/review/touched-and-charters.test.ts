/**
 * Direct coverage for the small helpers `lensesFor` composes.
 *
 * `lenses.test.ts` (ported from pi's own suite) drives every case
 * through `lensesFor`, deliberately, since that is the seam that
 * actually breaks. These are the pieces underneath it, exercised
 * directly rather than only through that composition.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DiffModel } from "../../../lib/core/review/index.ts";
import {
	agentsInRepo,
	chartersOnDisk,
	touchedBy,
} from "../../../lib/core/review/lenses.ts";

const dirs: string[] = [];

async function tmp(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (dirs.length > 0) {
		const dir = dirs.pop();
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	}
});

describe("touchedBy", () => {
	it("collects both sides of every file a diff names", () => {
		const diff: DiffModel = {
			files: [
				{ oldPath: "a.ts", newPath: "a.ts", status: "modified", hunks: [] },
				{ newPath: "b.ts", status: "added", hunks: [] },
			],
		};
		expect(touchedBy(diff)).toEqual(["a.ts", "a.ts", "b.ts"]);
	});

	it("reports unknown rather than 'touches nothing' for an empty diff", () => {
		const touched = touchedBy({ files: [] });
		expect(touched).not.toBeInstanceOf(Array);
		expect((touched as { unknown: string }).unknown).toContain(
			"names no paths",
		);
	});
});

describe("chartersOnDisk", () => {
	it("returns an empty map when the persona directory doesn't exist", async () => {
		const charters = await chartersOnDisk(join(tmpdir(), "no-such-dir-xyz"));
		expect(charters.size).toBe(0);
	});

	it("reads every persona markdown file into a charter", async () => {
		const dir = await tmp("personas-");
		await writeFile(
			join(dir, "security.md"),
			"---\nname: Security\ndescription: Looks for injection.\n---\n\nLook for injection.",
			"utf8",
		);

		const charters = await chartersOnDisk(dir);
		expect(charters.get("security")).toContain("injection");
	});

	it("lets the first directory that holds an id win over later ones", async () => {
		// The operator's own directory is asked before the lenses a package
		// ships, so writing a file of the same name replaces a built-in one
		// and every other built-in still answers.
		const mine = await tmp("mine-");
		const shipped = await tmp("shipped-");
		const persona = (lens: string) =>
			`---\nname: Lens\ndescription: A lens.\n---\n\n${lens}`;
		await writeFile(join(mine, "security.md"), persona("Mine."), "utf8");
		await writeFile(join(shipped, "security.md"), persona("Shipped."), "utf8");
		await writeFile(join(shipped, "tests.md"), persona("Tests."), "utf8");

		const charters = await chartersOnDisk([
			mine,
			join(tmpdir(), "no-such-dir-xyz"),
			shipped,
		]);
		expect(charters.get("security")).toContain("Mine.");
		expect(charters.get("tests")).toContain("Tests.");
	});
});

describe("agentsInRepo", () => {
	it("finds no agents when neither directory exists", async () => {
		const dir = await tmp("repo-");
		const found = await agentsInRepo(dir, []);
		expect(found.agents).toEqual([]);
		expect(found.skipped).toEqual([]);
	});

	it("reads agent files under .claude/agents", async () => {
		const dir = await tmp("repo-");
		await mkdir(join(dir, ".claude", "agents"), { recursive: true });
		await writeFile(
			join(dir, ".claude", "agents", "reviewer.md"),
			"---\nname: reviewer\ndescription: Focuses on style.\n---\n\nFocus on style.",
			"utf8",
		);

		const found = await agentsInRepo(dir, []);
		expect(found.agents.map((a) => a.id)).toContain("repo:reviewer");
	});
});
