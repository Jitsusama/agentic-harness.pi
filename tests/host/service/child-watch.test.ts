/** What a host makes of its child's answer to a watch, and of each line after, over a real socket. */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ChildEnding,
	type ChildWatcher,
	watchChild,
} from "../../../host/service/child-watch.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
/** Long enough for a child on a loaded machine, short enough that a hang fails the case. */
const ANSWER_MS = 5_000;
const conversation = {
	sessionId: A,
	file: "/sessions/a.jsonl",
	cwd: "/repo",
	state: "idle",
	since: "2026-11-09T15:00:00.000Z",
};
const entry = {
	sessionId: A,
	file: "/sessions/a.jsonl",
	cwd: "/repo",
	attended: true,
	since: "2026-11-09T15:00:00.000Z",
};
const watch = {
	ok: true,
	result: {
		version: "1",
		host: { key: "child", owner: { pid: 7, startedAt: 1 } },
		conversation,
		entry,
	},
};

const servers: Server[] = [];
const folders: string[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.close();
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

/** A child at a socket that answers a watch with `lines`, one JSON line each. */
async function childSaying(lines: readonly unknown[]): Promise<string> {
	const folder = mkdtempSync(join(tmpdir(), "cw-"));
	folders.push(folder);
	const socket = join(folder, "child.sock");
	const server = createServer((connection) => {
		connection.once("data", () => {
			for (const line of lines) connection.write(`${JSON.stringify(line)}\n`);
		});
	});
	servers.push(server);
	await new Promise<void>((listening) => server.listen(socket, listening));
	return socket;
}

/** A watcher that keeps what it was told. */
function keeping() {
	const told = {
		ended: [] as ChildEnding[],
		became: [] as string[],
		misread: [] as string[],
	};
	let ended: (why: ChildEnding) => void = () => undefined;
	const end = new Promise<ChildEnding>((done) => {
		ended = done;
	});
	const watcher: ChildWatcher = {
		watched: () => undefined,
		state: () => undefined,
		became: (previousId) => told.became.push(previousId),
		ended: (why) => {
			told.ended.push(why);
			ended(why);
		},
		misread: (error) => told.misread.push(error.message),
	};
	return { told, watcher, end };
}

describe("a child's answer to its watch", () => {
	it("says the child refused, in the child's words", async () => {
		const socket = await childSaying([
			{ ok: false, error: { message: "no such conversation" } },
		]);
		await expect(
			watchChild(socket, ANSWER_MS, keeping().watcher),
		).rejects.toThrow('The child refused its watch: "no such conversation"');
	});

	it("says what was missing when the child answers with no watch", async () => {
		const socket = await childSaying([{ ok: true, result: { version: "1" } }]);
		await expect(
			watchChild(socket, ANSWER_MS, keeping().watcher),
		).rejects.toThrow(/^The child answered its watch with no watch: \/result/);
	});

	it("refuses a watch whose roster entry is no roster entry, so a child can't write one", async () => {
		const socket = await childSaying([
			{
				...watch,
				result: { ...watch.result, entry: { ...entry, file: "relative" } },
			},
		]);
		await expect(
			watchChild(socket, ANSWER_MS, keeping().watcher),
		).rejects.toThrow("not a roster entry");
	});

	it("takes a watch, passing over what a newer child says beyond it", async () => {
		const socket = await childSaying([
			{
				...watch,
				later: true,
				result: {
					...watch.result,
					conversation: { ...conversation, state: "dreaming", mood: 1 },
					entry: { ...entry, colour: "blue" },
				},
			},
		]);
		const { watcher } = keeping();
		const watched = await watchChild(socket, ANSWER_MS, watcher);
		expect(watched.conversation).toEqual({ ...conversation, state: "busy" });
		expect(watched.entry).toEqual(entry);
		watched.close();
	});
});

describe("a child's lines after its answer", () => {
	it("ends the watch as failed on a became whose entry is no roster entry", async () => {
		const socket = await childSaying([
			watch,
			{
				type: "became",
				previousId: A,
				conversation: { ...conversation, sessionId: B },
				entry: { ...entry, sessionId: B, attended: "yes" },
			},
		]);
		const { told, watcher, end } = keeping();
		await watchChild(socket, ANSWER_MS, watcher);
		expect(await end).toBe("failed");
		expect(told.became).toEqual([]);
	});

	it("passes over a line it can't read, saying why, and takes an unreadable ending as a park", async () => {
		const socket = await childSaying([
			watch,
			{ type: "state", conversation: { ...conversation, cwd: "relative" } },
			{ type: "ending", why: "exploded" },
		]);
		const { told, watcher, end } = keeping();
		await watchChild(socket, ANSWER_MS, watcher);
		expect(await end).toBe("parked");
		expect(told.misread[0]).toMatch(
			/^passed over a line it can't read: \/conversation\/cwd: /,
		);
	});
});
