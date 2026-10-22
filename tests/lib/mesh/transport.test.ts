/**
 * The folder transport: what goes in, what comes out, and how far a
 * peer has read.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL } from "../../../lib/mesh/group.ts";
import type { Draft } from "../../../lib/mesh/message.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mesh-transport-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const draft = (over: Partial<Draft> = {}): Draft => ({
	from: "WCJQSG",
	to: [ALL],
	intent: "hold",
	text: "hold heavy builds",
	pid: 1,
	...over,
});

describe("the folder transport", () => {
	it("stamps what it sends and hands it back, oldest first, leaving nothing staged", async () => {
		const transport = folderTransport(join(dir, "messages"));

		const first = transport.send(draft({ text: "one" }));
		await new Promise((wake) => setTimeout(wake, 2));
		const second = transport.send(draft({ text: "two" }));

		expect(first).toMatchObject({ v: 1, from: "WCJQSG", text: "one" });
		expect(Date.parse(first.at)).not.toBeNaN();
		expect(transport.ids()).toEqual([first.id, second.id]);
		expect(transport.read(second.id)).toEqual(second);
		expect(
			readdirSync(join(dir, "messages")).filter((f) => f.startsWith(".")),
		).toEqual([]);
	});

	it("keeps two messages sent in the same millisecond", () => {
		const transport = folderTransport(dir);

		for (let n = 0; n < 20; n++) transport.send(draft({ text: `${n}` }));

		expect(transport.ids()).toHaveLength(20);
	});

	it("gives what one process sends ids that rise, within a millisecond too", () => {
		const transport = folderTransport(dir);

		const sent = Array.from({ length: 20 }, (_, n) =>
			transport.send(draft({ text: `${n}` })),
		);

		expect(transport.ids()).toEqual(sent.map(({ id }) => id));
	});

	it("passes over a file that is not a message", () => {
		const transport = folderTransport(dir);
		writeFileSync(join(dir, "1-X-1.json"), '{"nope":1}', "utf8");
		writeFileSync(join(dir, "2-X-1.json"), "{torn", "utf8");

		expect(transport.read("1-X-1")).toBeUndefined();
		expect(transport.read("2-X-1")).toBeUndefined();
	});

	it("answers an empty listing when the folder is not there yet", () => {
		expect(folderTransport(join(dir, "never")).ids()).toEqual([]);
	});

	it("remembers the furthest a peer has read, under any of its addresses", () => {
		const transport = folderTransport(dir);
		transport.markRead("7M6JKG", "200-A-1");
		transport.markRead("01A15F3A", "300-A-1");

		expect(transport.lastRead(["7M6JKG", "01A15F3A"])).toBe("300-A-1");
		expect(transport.lastRead(["NOBODY"])).toBeUndefined();
	});

	it("never winds a marker back", () => {
		// A watcher can report an older message after a newer one, and a
		// marker wound back hands the newer one out again.
		const transport = folderTransport(dir);
		transport.markRead("7M6JKG", "300-A-1");
		transport.markRead("7M6JKG", "200-A-1");

		expect(transport.lastRead(["7M6JKG"])).toBe("300-A-1");
	});

	it("tells a watcher each message that arrives, until it stops", async () => {
		const transport = folderTransport(dir);
		const arrived: string[] = [];
		const stop = transport.watch((id) => arrived.push(id));

		const sent = transport.send(draft());

		await vi.waitFor(() => expect(arrived).toContain(sent.id));
		stop();
	});
});
