/**
 * Asking niri to open a window on the asking session's workspace: its
 * IPC, one JSON line each way, and the workspace told only when one
 * window carries the asker's title.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	classOfItsOwn,
	niriAt,
	placeOnAskersWorkspace,
	windowsIn,
	workspaceTitled,
} from "../../../lib/terminal/niri.ts";

let dir: string;
let server: Server | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "niri-"));
});

afterEach(async () => {
	await new Promise<void>((done) =>
		server ? server.close(() => done()) : done(),
	);
	server = undefined;
	rmSync(dir, { recursive: true, force: true });
});

/** A niri socket answering each request line with `answer` of it. */
async function socketAnswering(
	answer: (request: unknown) => string | undefined,
): Promise<string> {
	const path = join(dir, "niri.sock");
	server = createServer((stream) => {
		stream.on("data", (chunk) => {
			const line = chunk.toString("utf8").split("\n")[0] ?? "";
			const reply = answer(JSON.parse(line));
			if (reply !== undefined) stream.write(`${reply}\n`);
		});
	});
	await new Promise<void>((done) => server?.listen(path, done));
	return path;
}

describe("niri's IPC", () => {
	it("sends one request on a line and answers its reply", async () => {
		const seen: unknown[] = [];
		const socket = await socketAnswering((request) => {
			seen.push(request);
			return JSON.stringify({ Ok: { Windows: [] } });
		});

		expect(await niriAt(socket)("Windows")).toEqual({ Ok: { Windows: [] } });
		expect(seen).toEqual(["Windows"]);
	});

	it("gives up on a niri that doesn't answer", async () => {
		const socket = await socketAnswering(() => undefined);

		await expect(niriAt(socket, 50)("Windows")).rejects.toThrow(
			"niri didn't answer in time",
		);
	});

	it("fails when there is no niri to reach", async () => {
		await expect(niriAt(join(dir, "none.sock"))("Windows")).rejects.toThrow();
	});
});

describe("the asker's workspace", () => {
	const windows = windowsIn({
		Ok: {
			Windows: [
				{ title: "π - Harness - agentic-harness.pi", workspace_id: 3 },
				{ title: "π - Twice - delta", workspace_id: 1 },
				{ title: "π - Twice - delta", workspace_id: 5 },
				{ title: "floating", workspace_id: null },
			],
		},
	});

	it("is the one holding the only window of its title", () => {
		expect(workspaceTitled(windows, "π - Harness - agentic-harness.pi")).toBe(
			3,
		);
	});

	it("is not told when two windows share the title, or none has it", () => {
		expect(workspaceTitled(windows, "π - Twice - delta")).toBeUndefined();
		expect(workspaceTitled(windows, "π - Gone - core.nix")).toBeUndefined();
	});

	it("reads nothing from a reply that isn't a window list", () => {
		expect(windowsIn({ Err: "no" })).toEqual([]);
	});
});

describe("a class of its own", () => {
	it("is one the compositor's rule for spawned windows matches, never the same twice", () => {
		const first = classOfItsOwn(4242);
		const second = classOfItsOwn(4242);

		expect(first).toMatch(/^pi-spawned(\.[0-9]+)?$/);
		expect(second).not.toBe(first);
	});
});

describe("placing a window", () => {
	it("is not asked of a niri that knows no window of the asker's title", async () => {
		const asked: unknown[] = [];
		const placed = await placeOnAskersWorkspace(async (request) => {
			asked.push(request);
			return { Ok: { Windows: [] } };
		}, "π - Harness - agentic-harness.pi");

		expect(placed).toBeUndefined();
		expect(asked).toEqual(["Windows"]);
	});
});
