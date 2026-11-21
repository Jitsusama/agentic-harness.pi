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
import { fenceRefusal } from "../../../extensions/subagent-workflow/fence-keep.ts";

describe("a subagent keeps the fence", () => {
	let place: string;
	let root: string;
	let outside: string;

	beforeEach(async () => {
		place = await realpath(await mkdtemp(join(tmpdir(), "fence-keep-")));
		root = join(place, "package");
		outside = join(place, "elsewhere");
		await mkdir(join(root, "packs"), { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(root, "packs", "own.ts"), "");
		await writeFile(join(outside, "planted.ts"), "");
	});

	afterEach(async () => {
		await rm(place, { recursive: true, force: true });
	});

	it("lets a job load the package's own extension", () => {
		const job = {
			id: "a",
			cwd: outside,
			extraExtensions: [join(root, "packs", "own.ts")],
		};
		expect(fenceRefusal([job], root)).toBeUndefined();
	});

	it("refuses an extension from outside the package", () => {
		const job = {
			id: "a",
			cwd: outside,
			extraExtensions: [join(outside, "planted.ts")],
		};
		expect(fenceRefusal([job], root)).toContain(
			"planted.ts isn't this package's own",
		);
	});

	it("refuses a verify extension from outside the package", () => {
		const job = {
			id: "a",
			cwd: outside,
			verify: { extensionPath: join(outside, "planted.ts") },
		};
		expect(fenceRefusal([job], root)).toContain("planted.ts");
	});

	it("follows a link out of the package before judging it", async () => {
		const link = join(root, "packs", "link.ts");
		await symlink(join(outside, "planted.ts"), link);
		const job = { id: "a", cwd: outside, extraExtensions: [link] };
		expect(fenceRefusal([job], root)).toContain("link.ts");
	});

	it("refuses a path that doesn't exist", () => {
		const job = {
			id: "a",
			cwd: outside,
			extraExtensions: [join(root, "packs", "gone.ts")],
		};
		expect(fenceRefusal([job], root)).toContain("gone.ts");
	});

	it("refuses lifting isolation where the folder's .pi holds code", async () => {
		await mkdir(join(outside, ".pi", "extensions"), { recursive: true });
		const job = { id: "a", cwd: outside, isolated: false };
		expect(fenceRefusal([job], root)).toContain("holds extensions");
	});

	it("refuses lifting isolation where the folder's .pi has settings", async () => {
		await mkdir(join(outside, ".pi"), { recursive: true });
		await writeFile(join(outside, ".pi", "settings.json"), "{}");
		const job = { id: "a", cwd: outside, isolated: false };
		expect(fenceRefusal([job], root)).toContain("settings.json");
	});

	it("lets isolation lift where the folder's .pi holds only skills", async () => {
		await mkdir(join(outside, ".pi", "skills"), { recursive: true });
		const job = { id: "a", cwd: outside, isolated: false };
		expect(fenceRefusal([job], root)).toBeUndefined();
	});

	it("lets an isolated job run beside a .pi that holds code", async () => {
		await mkdir(join(outside, ".pi", "extensions"), { recursive: true });
		const job = { id: "a", cwd: outside };
		expect(fenceRefusal([job], root)).toBeUndefined();
	});
});
