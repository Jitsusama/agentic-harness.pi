/**
 * Which live host holds a conversation, from the lists the hosts keep,
 * so plain pi never becomes a second writer on its log.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostRegistry } from "../../../../lib/core/session/host.ts";
import {
	type TickedOwner,
	tickedOwnerNow,
} from "../../../../lib/internal/process-ticks.ts";
import {
	heldElsewhere,
	liveHolder,
} from "../../../../lib/internal/session/one-writer.ts";

const held = "01a1be5c-fff0-70a1-9301-f505d5634bf6";
const other = "019e0c11-2b2c-7bd5-9e04-1c3c0a5b7a10";
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "one-writer-"));
	mkdirSync(dir, { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Write a host's list as session-host.ts does. */
function list(key: string, owner: TickedOwner, sessions: string[]): void {
	const registry: HostRegistry = {
		key,
		owner,
		sessions: sessions.map((id) => ({
			id,
			state: "idle",
			since: "2026-11-10T23:17:00.000Z",
		})),
	};
	writeFileSync(
		join(dir, `${owner.pid}-${owner.startTicks}.json`),
		JSON.stringify(registry),
	);
}

const running = { pid: 4100, startedAt: 1_794_370_632_830, startTicks: 141 };
const dead = { pid: 4300, startedAt: 1_794_360_000_000, startTicks: 90 };
const standing = async (owner: TickedOwner) =>
	owner.pid === running.pid ? ("running" as const) : ("gone" as const);

describe("the live host holding a conversation", () => {
	it("is the running host whose list names it", async () => {
		list("work-attended", { ...running, pid: 4101 }, [other]);
		list("work-background", running, [held]);

		expect(await liveHolder(held, { dir, standing })).toEqual({
			key: "work-background",
			pid: running.pid,
		});
	});

	it("is nobody when only a host that died lists it", async () => {
		list("work-background", dead, [held]);

		expect(
			await liveHolder(held, { dir, standing }),
			"a crashed host's list holds nothing",
		).toBeUndefined();
	});

	it("is nobody when no list names it, or no host has run", async () => {
		list("work-background", running, [other]);

		expect(await liveHolder(held, { dir, standing })).toBeUndefined();
		expect(
			await liveHolder(held, { dir: join(dir, "none"), standing }),
		).toBeUndefined();
	});

	it("passes over a list that does not read as one", async () => {
		writeFileSync(join(dir, "4500-1.json"), "{ not a list");
		list("work-background", running, [held]);

		expect((await liveHolder(held, { dir, standing }))?.key).toBe(
			"work-background",
		);
	});

	it("is judged by the machine by the process's own start, so a reused pid is no host", async () => {
		const owner = await tickedOwnerNow();
		if (owner?.startTicks === undefined) return;
		list("work-background", owner, [held]);
		expect((await liveHolder(held, { dir }))?.pid).toBe(process.pid);

		rmSync(join(dir, `${owner.pid}-${owner.startTicks}.json`));
		list("work-background", { ...owner, startTicks: owner.startTicks + 1 }, [
			held,
		]);
		expect(
			await liveHolder(held, { dir }),
			"a pid whose start differs from the list's is another process",
		).toBeUndefined();
	});

	it("is said by its key and pid", () => {
		expect(heldElsewhere(held, { key: "work-background", pid: 4100 })).toBe(
			`Conversation ${held} is open in the work-background host (pid 4100), so plain pi won't open it as a second writer on its log. Reach it through that host, or move it to pi first. Nothing was written.`,
		);
	});
});
