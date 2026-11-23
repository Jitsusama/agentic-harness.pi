/**
 * Finding a repository here with a carried tree's origin, through real
 * git: beside where the tree goes, in World's trees/<name>/src layout,
 * and never one that lacks what it left out.
 */

import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { twinOf } from "../../../../lib/internal/carry/twin.ts";
import {
	bareOrigin,
	cloneAt,
	exec,
	folder,
	removeAll,
} from "./support/machines.ts";

const run = promisify(execFile);

const made: string[] = [];
afterEach(() => removeAll(made));

describe("a carried tree's twin", () => {
	it("is a sibling tree's repository in World's trees/<name>/src layout", async () => {
		const origin = await bareOrigin(made);
		const home = folder(made, "home");
		const sibling = await cloneAt(origin, join(home, "trees", "root", "src"));

		expect(
			await twinOf(exec, join(home, "trees", "carried", "src"), origin),
		).toBe(join(sibling, ".git"));
	});

	it("is none where every repository beside it has another origin", async () => {
		const origin = await bareOrigin(made);
		const other = await bareOrigin(made);
		const home = folder(made, "home");
		await cloneAt(other, join(home, "src", "other"));

		expect(await twinOf(exec, join(home, "src", "app"), origin)).toBe(
			undefined,
		);
	});

	it("is never a shallow repository, which lacks the history it cut", async () => {
		const origin = await bareOrigin(made);
		const home = folder(made, "home");
		mkdirSync(join(home, "src"));
		await run("git", [
			"clone",
			"-q",
			"--depth",
			"1",
			`file://${origin}`,
			join(home, "src", "shallow"),
		]);

		expect(
			await twinOf(exec, join(home, "src", "app"), `file://${origin}`),
		).toBe(undefined);
	});
});
