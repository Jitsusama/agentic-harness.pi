/**
 * Which rounds' reviewers run on a room: only a change on a repository
 * the room keeps, with its head known, and only once the package
 * config names a room.
 */

import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
	myceliumAt,
	roomFor,
} from "../../../../extensions/review-integration/tools/ask-room.ts";
import type { ChangeRef } from "../../../../lib/core/review/index.ts";

const harness = { root: "/pkg", entryLoads: ["/pkg/fence.ts"] };
const head = "b".repeat(40);

/** Where the node's command lies, as PATH finds it. */
const MYCELIUM = "/run/node/bin/mycelium";
const found = () => MYCELIUM;

/** A change on the repository `key` names. */
const change = (key: string): ChangeRef => ({
	provider: "github",
	repo: { key },
	id: "1",
	label: `${key}#1`,
});

/** A package config holding `review`, as its file. */
async function config(review: unknown): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ask-room-"));
	const path = join(dir, "config.json");
	await writeFile(path, JSON.stringify({ version: 1, sections: { review } }));
	return path;
}

describe("the room a round's reviewers run on", () => {
	it("is the one the config names, for a repository it keeps", async () => {
		const path = await config({ room: { machine: "room-1" } });

		expect(
			await roomFor(
				change("github:Jitsusama/agentic-harness.pi"),
				head,
				harness,
				path,
				found,
			),
		).toEqual({
			place: {
				mycelium: MYCELIUM,
				realm: "work",
				machine: "room-1",
				harnessRoot: "/pkg",
				entryLoads: ["/pkg/fence.ts"],
			},
			code: { repo: "agentic-harness.pi", commit: head },
		});
	});

	it("is in the realm the config names", async () => {
		const path = await config({ room: { machine: "room-1", realm: "home" } });

		const room = await roomFor(
			change("github:Jitsusama/core.nix"),
			head,
			harness,
			path,
			found,
		);

		expect(room?.place.realm).toBe("home");
		expect(room?.code.repo).toBe("core.nix");
	});

	it("is none for a repository no room keeps, or another owner's", async () => {
		const path = await config({ room: { machine: "room-1" } });

		for (const key of ["github:shop/world", "github:someone/core.nix"]) {
			expect(await roomFor(change(key), head, harness, path)).toBeUndefined();
		}
	});

	it("is none with no head, or when the config names no room", async () => {
		const named = await config({ room: { machine: "room-1" } });
		const none = await config({ ask: {} });
		const misnamed = await config({ room: { machine: "" } });
		const mine = change("github:Jitsusama/mycelium");

		expect(await roomFor(mine, undefined, harness, named)).toBeUndefined();
		expect(await roomFor(mine, head, harness, none)).toBeUndefined();
		expect(await roomFor(mine, head, harness, misnamed)).toBeUndefined();
	});

	it("is none when the node's command can't be found, so the round runs here", async () => {
		const named = await config({ room: { machine: "room-1" } });
		const mine = change("github:Jitsusama/mycelium");

		expect(
			await roomFor(mine, head, harness, named, () => undefined),
		).toBeUndefined();
	});
});

describe("the node's command a room is reached through", () => {
	it("is found on PATH's absolute folders only, never a relative one the snapshot could fill", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ask-room-bin-"));
		const bin = join(dir, "bin");
		await mkdir(bin);
		const command = join(bin, "mycelium");
		await writeFile(command, "#!/bin/sh\n");
		await chmod(command, 0o755);

		// The same folder named relatively, as a tree's PATH entry would be.
		const near = relative(process.cwd(), bin);

		expect(myceliumAt(`${near}:${bin}`)).toBe(command);
		expect(myceliumAt(near)).toBeUndefined();
		expect(myceliumAt("")).toBeUndefined();
	});
});
