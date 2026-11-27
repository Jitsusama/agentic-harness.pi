/**
 * Which rounds' reviewers run on a room: only a change on a repository
 * the room keeps, with its head known, and only once the package
 * config names a room.
 */

import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	myceliumAt,
	roomFor,
} from "../../../../extensions/review-integration/tools/ask-room.ts";
import type { ChangeRef } from "../../../../lib/core/review/index.ts";

const harness = () => ({ root: "/pkg", entryLoads: ["/pkg/fence.ts"] });
const head = "b".repeat(40);

/** Where the node's command lies, standing in for the system profile's. */
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
			expect(
				await roomFor(change(key), head, harness, path, found),
			).toBeUndefined();
		}
	});

	it("is none with no head, or when the config names no room", async () => {
		const named = await config({ room: { machine: "room-1" } });
		const none = await config({ ask: {} });
		const misnamed = await config({ room: { machine: "" } });
		const mine = change("github:Jitsusama/mycelium");

		expect(
			await roomFor(mine, undefined, harness, named, found),
		).toBeUndefined();
		expect(await roomFor(mine, head, harness, none, found)).toBeUndefined();
		expect(await roomFor(mine, head, harness, misnamed, found)).toBeUndefined();
	});

	it("is none when the node's command can't be found, so the round runs here", async () => {
		const named = await config({ room: { machine: "room-1" } });
		const mine = change("github:Jitsusama/mycelium");

		expect(
			await roomFor(mine, head, harness, named, () => undefined),
		).toBeUndefined();
	});

	it("is none when the fence refuses the round's folder, which each reviewer then says as it starts", async () => {
		const named = await config({ room: { machine: "room-1" } });
		const mine = change("github:Jitsusama/mycelium");
		const refused = () => {
			throw new Error("the folder holds the fence's own code");
		};

		expect(await roomFor(mine, head, refused, named, found)).toBeUndefined();
	});

	it("asks for the harness only once a room is named, so a round with none never meets the fence's refusal there", async () => {
		const mine = change("github:Jitsusama/mycelium");
		let asked = 0;
		const counted = () => {
			asked += 1;
			return harness();
		};

		await roomFor(mine, head, counted, await config({}), found);
		expect(asked).toBe(0);
	});

	it("is the node's first room when the config says to take it from there", async () => {
		const path = await config({
			room: { from: "agent-rooms", realm: "work" },
		});
		const rooms = join(await mkdtemp(join(tmpdir(), "ask-room-")), "rooms");
		await writeFile(rooms, "# the node's rooms\n\n  room-2  \nroom-3\n");

		const room = await roomFor(
			change("github:Jitsusama/agentic-harness.pi"),
			head,
			harness,
			path,
			found,
			rooms,
		);

		expect(room?.place.machine).toBe("room-2");
		expect(room?.place.realm).toBe("work");
	});

	it("is none when the node's list is gone or names no room, so the round runs here", async () => {
		const path = await config({ room: { from: "agent-rooms" } });
		const dir = await mkdtemp(join(tmpdir(), "ask-room-"));
		const empty = join(dir, "empty");
		await writeFile(empty, "# none lent now\n");
		const mine = change("github:Jitsusama/mycelium");

		for (const rooms of [empty, join(dir, "gone")]) {
			expect(
				await roomFor(mine, head, harness, path, found, rooms),
				rooms,
			).toBeUndefined();
		}
	});
});

describe("the node's command a room is reached through", () => {
	it("is never one in a folder this account could write, as a fenced command could plant", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ask-room-bin-"));
		const bin = join(dir, "bin");
		await mkdir(bin);
		const command = join(bin, "mycelium");
		await writeFile(command, "#!/bin/sh\n");
		await chmod(command, 0o755);

		expect(myceliumAt([bin])).toBeUndefined();
	});

	it.skipIf(myceliumAt() === undefined)(
		"is the system profile's, where this machine installs it",
		() => {
			expect(myceliumAt()).toMatch(/^\/nix\/store\/.+\/bin\/mycelium$/);
		},
	);
});
