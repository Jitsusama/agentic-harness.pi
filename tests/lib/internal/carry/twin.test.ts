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
import {
	guardedCheckoutOf,
	twinOf,
} from "../../../../lib/internal/carry/twin.ts";
import { git } from "../../../support/git-fixture.ts";
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

	it("is never a repository borrowing its objects from another", async () => {
		const origin = await bareOrigin(made);
		const home = folder(made, "home");
		mkdirSync(join(home, "src"));
		await run("git", [
			"clone",
			"-q",
			"--shared",
			origin,
			join(home, "src", "borrowing"),
		]);

		expect(await twinOf(exec, join(home, "src", "app"), origin)).toBe(
			undefined,
		);
	});
});

describe("a checkout the fence guards for a carried tree", () => {
	/** Where the work tool cuts trees, under `home`, and a tree there. */
	const cutIn = (home: string) =>
		join(home, ".local", "state", "pi", "work", "trees", "app-topic");

	it.each([
		["git@example.com:owner/app.git", ["example.com", "owner", "app"]],
		["https://example.com/owner/app", ["example.com", "owner", "app"]],
		["ssh://git@example.com/owner/app.git", ["owner", "app"]],
		["/srv/git/app.git", ["app"]],
	])("is the checkout under ~/src that %s names", async (url, at) => {
		const origin = await bareOrigin(made);
		const home = folder(made, "home");
		const checkout = await cloneAt(origin, join(home, "src", ...at));
		await git(checkout, "remote", "set-url", "origin", url);

		expect(await guardedCheckoutOf(exec, cutIn(home), url, home)).toBe(
			join(checkout, ".git"),
		);
	});

	it("is never a repository the fence doesn't guard, though it is a twin", async () => {
		const origin = await bareOrigin(made);
		const home = folder(made, "home");
		const tree = cutIn(home);
		const sibling = await cloneAt(origin, join(tree, "..", "app-other"));

		expect(await twinOf(exec, tree, origin)).toBe(join(sibling, ".git"));
		expect(await guardedCheckoutOf(exec, tree, origin, home)).toBe(undefined);
	});

	it("is none where ~/src holds no checkout of its origin", async () => {
		const origin = await bareOrigin(made);
		const other = await bareOrigin(made);
		const home = folder(made, "home");
		await cloneAt(other, join(home, "src", "origin"));

		expect(await guardedCheckoutOf(exec, cutIn(home), origin, home)).toBe(
			undefined,
		);
	});
});
