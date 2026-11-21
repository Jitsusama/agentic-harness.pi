/** How the subagent tool keeps a model from loading code past the fence. */

import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fenceChildren,
	keepFence,
} from "../../../extensions/subagent-workflow/fence-keep.ts";
import type { FleetAssignment } from "../../../extensions/subagent-workflow/run.ts";

/** The refusal, or undefined when the jobs may run. */
function refusal(kept: ReturnType<typeof keepFence>): string | undefined {
	return kept.ok ? undefined : kept.refusal;
}

describe("a subagent keeps the fence", () => {
	let place: string;
	let root: string;
	let outside: string;

	beforeEach(async () => {
		place = await realpath(await mkdtemp(join(tmpdir(), "fence-keep-")));
		root = join(place, "pi-packages");
		outside = join(place, "elsewhere");
		await mkdir(join(root, "packs"), { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(root, "packs", "own.ts"), "");
		await writeFile(join(outside, "planted.ts"), "");
	});

	afterEach(async () => {
		await rm(place, { recursive: true, force: true });
	});

	it("lets a job load an installed extension", () => {
		const own = join(root, "packs", "own.ts");
		const kept = keepFence([{ id: "a", extraExtensions: [own] }], root);
		expect(kept).toEqual({
			ok: true,
			jobs: [{ id: "a", extraExtensions: [own] }],
		});
	});

	it("refuses an extension from outside the install", () => {
		const job = { id: "a", extraExtensions: [join(outside, "planted.ts")] };
		expect(refusal(keepFence([job], root))).toContain(
			"planted.ts lies outside pi's installed packages",
		);
	});

	it("refuses a folder beside the install whose name starts the same", async () => {
		const beside = join(place, "pi-packages-evil");
		await mkdir(beside);
		await writeFile(join(beside, "x.ts"), "");
		const job = { id: "a", extraExtensions: [join(beside, "x.ts")] };
		expect(refusal(keepFence([job], root))).toContain("x.ts lies outside");
	});

	it("refuses a verify extension from outside the install", () => {
		const job = {
			id: "a",
			verify: { extensionPath: join(outside, "planted.ts") },
		};
		expect(refusal(keepFence([job], root))).toContain(
			"planted.ts lies outside",
		);
	});

	it("refuses a relative path, whatever it names", () => {
		const job = { id: "a", extraExtensions: ["packs/own.ts"] };
		expect(refusal(keepFence([job], root))).toContain(
			"packs/own.ts isn't an absolute path",
		);
	});

	it("follows a link out of the install before judging it", async () => {
		const link = join(root, "packs", "link.ts");
		await symlink(join(outside, "planted.ts"), link);
		const job = { id: "a", extraExtensions: [link] };
		expect(refusal(keepFence([job], root))).toContain("link.ts lies outside");
	});

	it("hands the child the path as followed, so a link swapped later can't move it", async () => {
		const own = join(root, "packs", "own.ts");
		const link = join(outside, "link.ts");
		await symlink(own, link);
		const job = {
			id: "a",
			extraExtensions: [link],
			verify: { extensionPath: link, skillPath: "/s" },
		};
		expect(keepFence([job], root)).toEqual({
			ok: true,
			jobs: [
				{
					id: "a",
					extraExtensions: [own],
					verify: { extensionPath: own, skillPath: "/s" },
				},
			],
		});
	});

	it("says a path inside the install that isn't there can't be found", () => {
		const job = { id: "a", extraExtensions: [join(root, "packs", "gone.ts")] };
		expect(refusal(keepFence([job], root))).toContain("gone.ts can't be found");
	});

	it("refuses every named extension when the install can't be found", () => {
		const own = join(root, "packs", "own.ts");
		expect(
			refusal(keepFence([{ id: "a", extraExtensions: [own] }], null)),
		).toContain("pi's installed packages can't be found");
	});

	it("lets a job that names no extension run", () => {
		expect(keepFence([{ id: "a" }], null).ok).toBe(true);
	});
});

describe("a fenced session's children", () => {
	const packs = ["/p/bash.ts", "/p/files.ts"];
	const assignment = (job: object): FleetAssignment => ({
		spec: { id: "a" },
		job: { userPrompt: "go", cwd: "/w", ...job },
	});

	it("loads the fence's extensions first in an isolated child, once each", () => {
		const [out] = fenceChildren(
			[
				assignment({
					isolated: true,
					extraExtensions: ["/p/files.ts", "/x.ts"],
				}),
			],
			"fence",
			packs,
		);
		expect(out?.job.extraExtensions).toEqual([
			"/p/bash.ts",
			"/p/files.ts",
			"/x.ts",
		]);
		expect(out?.job.env).toEqual({ PI_SANDBOX: "fence" });
	});

	it("names the sandbox to an unisolated child and loads nothing more", () => {
		const [out] = fenceChildren(
			[assignment({ isolated: false, env: { A: "1" } })],
			"strict",
			packs,
		);
		expect(out?.job.extraExtensions).toBeUndefined();
		expect(out?.job.env).toEqual({ A: "1", PI_SANDBOX: "strict" });
	});

	it("leaves an unfenced session's children alone", () => {
		const given = [assignment({ isolated: true })];
		expect(fenceChildren(given, undefined, packs)).toEqual(given);
	});
});
