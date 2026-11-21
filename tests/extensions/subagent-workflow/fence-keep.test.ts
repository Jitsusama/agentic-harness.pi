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
	childSandbox,
	fenceChildren,
	fencePacks,
	keepFence,
} from "../../../extensions/subagent-workflow/fence-keep.ts";
import type { FleetAssignment } from "../../../extensions/subagent-workflow/run.ts";

/** The refusal, or undefined when the jobs may run. */
function refusal(kept: { ok: boolean; refusal?: string }): string | undefined {
	return kept.ok ? undefined : kept.refusal;
}

/** The extensions that fence a pi, as a package holds them. */
const PACKS = [
	["extensions", "shell-workflow", "index.ts"],
	["extensions", "sandbox-file-interceptor", "index.ts"],
	["extensions", "secret-scrub-interceptor", "index.ts"],
] as const;

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

/**
 * An install as pi-packages keeps one, under `root`: each version a
 * folder holding the fence's extensions, `current` linking the newest.
 */
async function install(versions: readonly string[]): Promise<string> {
	const at = join(root, "harness");
	for (const version of versions) {
		for (const pack of PACKS) {
			const file = join(at, "versions", version, ...pack);
			await mkdir(join(file, ".."), { recursive: true });
			await writeFile(file, "");
		}
	}
	await symlink(join("versions", versions.at(-1) ?? ""), join(at, "current"));
	return at;
}

describe("a fenced session's subagent keeps the fence", () => {
	it("lets a job load an installed extension", () => {
		const own = join(root, "packs", "own.ts");
		const kept = keepFence(
			[{ id: "a", extraExtensions: [own] }],
			"fence",
			root,
		);
		expect(kept).toEqual({
			ok: true,
			jobs: [{ id: "a", extraExtensions: [own] }],
		});
	});

	it("refuses an extension from outside the install", () => {
		const job = { id: "a", extraExtensions: [join(outside, "planted.ts")] };
		expect(refusal(keepFence([job], "fence", root))).toContain(
			"planted.ts lies outside pi's installed packages",
		);
	});

	it("refuses a folder beside the install whose name starts the same", async () => {
		const beside = join(place, "pi-packages-evil");
		await mkdir(beside);
		await writeFile(join(beside, "x.ts"), "");
		const job = { id: "a", extraExtensions: [join(beside, "x.ts")] };
		expect(refusal(keepFence([job], "fence", root))).toContain(
			"x.ts lies outside",
		);
	});

	it("refuses a verify extension from outside the install", () => {
		const job = {
			id: "a",
			verify: { extensionPath: join(outside, "planted.ts") },
		};
		expect(refusal(keepFence([job], "strict", root))).toContain(
			"planted.ts lies outside",
		);
	});

	it("refuses a relative path, whatever it names", () => {
		const job = { id: "a", extraExtensions: ["packs/own.ts"] };
		expect(refusal(keepFence([job], "fence", root))).toContain(
			"packs/own.ts isn't an absolute path",
		);
	});

	it("follows a link out of the install before judging it", async () => {
		const link = join(root, "packs", "link.ts");
		await symlink(join(outside, "planted.ts"), link);
		const job = { id: "a", extraExtensions: [link] };
		expect(refusal(keepFence([job], "fence", root))).toContain(
			"link.ts lies outside",
		);
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
		expect(keepFence([job], "fence", root)).toEqual({
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

	it("refuses an extension from a version its install has moved on from", async () => {
		const at = await install(["old", "new"]);
		const stale = join(at, "versions", "old", ...PACKS[0]);
		const job = { id: "a", extraExtensions: [stale] };
		expect(refusal(keepFence([job], "fence", root))).toContain(
			"its install has moved on from",
		);
	});

	it("lets a job name the current version, through its link", async () => {
		const at = await install(["old", "new"]);
		const job = {
			id: "a",
			extraExtensions: [join(at, "current", ...PACKS[0])],
		};
		expect(keepFence([job], "fence", root)).toEqual({
			ok: true,
			jobs: [
				{
					id: "a",
					extraExtensions: [join(at, "versions", "new", ...PACKS[0])],
				},
			],
		});
	});

	it("says a path inside the install that isn't there can't be found", () => {
		const job = { id: "a", extraExtensions: [join(root, "packs", "gone.ts")] };
		expect(refusal(keepFence([job], "fence", root))).toContain(
			"gone.ts can't be found",
		);
	});

	it("refuses every named extension when the install can't be found", () => {
		const own = join(root, "packs", "own.ts");
		expect(
			refusal(keepFence([{ id: "a", extraExtensions: [own] }], "fence", null)),
		).toContain("pi's installed packages can't be found");
	});

	it("lets a job that names no extension run", () => {
		expect(keepFence([{ id: "a" }], "fence", null).ok).toBe(true);
	});
});

describe("an unfenced session's subagents", () => {
	it("load what they are told, wherever it lies, since the parent's commands run as the person", () => {
		const job = { id: "a", extraExtensions: [join(outside, "planted.ts")] };
		expect(keepFence([job], undefined, root)).toEqual({
			ok: true,
			jobs: [job],
		});
	});
});

describe("whether a session's subagents are fenced", () => {
	it("follows the session's own sandbox", () => {
		expect(childSandbox({ PI_SANDBOX: "strict" }, () => false)).toBe("strict");
	});

	it("fences them once subagents join the first stage, under an unfenced session too", () => {
		expect(childSandbox({ PI_SANDBOX: "off" }, () => true)).toBe("fence");
	});

	it("leaves them unfenced when neither says so", () => {
		expect(childSandbox({ PI_SANDBOX: "off" }, () => false)).toBeUndefined();
	});
});

describe("the fence's own extensions", () => {
	it("come from the install's current version, each followed", async () => {
		const at = await install(["old", "new"]);
		expect(fencePacks(join(at, "current"), root)).toEqual({
			packs: PACKS.map((pack) => join(at, "versions", "new", ...pack)),
		});
	});

	it("are refused from a tree outside the install, which fenced commands may write", async () => {
		const tree = join(outside, "tree");
		for (const pack of PACKS) {
			await mkdir(join(tree, ...pack, ".."), { recursive: true });
			await writeFile(join(tree, ...pack), "");
		}
		expect(fencePacks(tree, root)).toEqual({
			why: expect.stringContaining("lies outside pi's installed packages"),
		});
	});

	it("say which one is missing when the install lacks it", async () => {
		const at = await install(["new"]);
		await rm(join(at, "versions", "new", ...PACKS[2]));
		expect(fencePacks(join(at, "current"), root)).toEqual({
			why: expect.stringContaining("secret-scrub-interceptor"),
		});
	});
});

describe("a fenced session's children", () => {
	const packs = ["/p/bash.ts", "/p/files.ts", "/p/scrub.ts"];
	const found = () => ({ packs });
	const assignment = (job: object): FleetAssignment => ({
		spec: { id: "a" },
		job: { userPrompt: "go", cwd: "/w", ...job },
	});
	const jobsOf = (kept: ReturnType<typeof fenceChildren>) =>
		kept.ok ? kept.jobs : [];

	it("loads every one of the fence's extensions first in an isolated child, once each", () => {
		const [out] = jobsOf(
			fenceChildren(
				[
					assignment({
						isolated: true,
						extraExtensions: ["/p/files.ts", "/x.ts"],
					}),
				],
				"fence",
				found,
			),
		);
		expect(out?.job.extraExtensions).toEqual([
			"/p/bash.ts",
			"/p/scrub.ts",
			"/p/files.ts",
			"/x.ts",
		]);
		expect(out?.job.env).toEqual({ PI_SANDBOX: "fence" });
		expect(out?.job.ignoreProject).toBe(true);
	});

	it("names the sandbox to an unisolated child, ignores the folder's .pi and loads nothing more", () => {
		const [out] = jobsOf(
			fenceChildren(
				[assignment({ isolated: false, env: { A: "1" } })],
				"strict",
				() => ({ why: "never asked" }),
			),
		);
		expect(out?.job.extraExtensions).toBeUndefined();
		expect(out?.job.env).toEqual({ A: "1", PI_SANDBOX: "strict" });
		expect(out?.job.ignoreProject).toBe(true);
	});

	it("starts no child when an isolated one can't have the fence's extensions", () => {
		expect(
			refusal(
				fenceChildren([assignment({ isolated: true })], "fence", () => ({
					why: "No subagent started: not installed",
				})),
			),
		).toBe("No subagent started: not installed");
	});

	it("leaves an unfenced session's children alone", () => {
		const given = [assignment({ isolated: true })];
		expect(fenceChildren(given, undefined, found)).toEqual({
			ok: true,
			jobs: given,
		});
	});
});
