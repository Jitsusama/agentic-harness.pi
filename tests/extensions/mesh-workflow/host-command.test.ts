/**
 * /host: the person moves the session in front of them into a host,
 * in its own window, or is told why it can't go and nothing changes.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type HostCommandFacts,
	moveIntoHost,
} from "../../../extensions/mesh-workflow/host-command.ts";
import type { HostKind } from "../../../host/service/address.ts";
import type { Moving } from "../../../lib/mesh/moving.ts";

let folder: string;
let wake: string;

beforeEach(() => {
	folder = mkdtempSync(join(tmpdir(), "host-command-"));
	wake = join(folder, "0d1e.wake");
	writeFileSync(join(folder, "0d1e.json"), JSON.stringify({ pid: 4242 }));
});

afterEach(() => {
	rmSync(folder, { recursive: true, force: true });
});

interface Asked {
	readonly facts: HostCommandFacts;
	readonly moved: HostKind[];
	readonly takenUp: string[];
	readonly probed: string[];
}

/** A plain pi its holder runs itself, in the work realm, unless `over` says. */
function asked(
	over: Partial<HostCommandFacts> & { failProbe?: string } = {},
): Asked {
	const moved: HostKind[] = [];
	const takenUp: string[] = [];
	const probed: string[] = [];
	let moving: Moving | undefined;
	const { failProbe, ...rest } = over;
	const facts: HostCommandFacts = {
		session: () => "01a1",
		hostedIn: () => undefined,
		moving: () => moving,
		sessionFile: () => "/logs/01a1.jsonl",
		handOver: () => ({ end: () => {} }),
		env: {
			MYCELIUM_REALM: "work",
			XDG_RUNTIME_DIR: "/run/user/1000",
			MYCELIUM_WAKE: wake,
			MYCELIUM_AGAIN: join(folder, "0d1e.again"),
		},
		pid: 4242,
		args: [],
		machine: "optimus",
		agents: async () => new Map([["optimus", "pi"]]),
		probe: async (socket) => {
			probed.push(socket);
			if (failProbe !== undefined)
				throw Object.assign(new Error(`connect ${failProbe} ${socket}`), {
					code: failProbe,
				});
		},
		move: (to) => {
			moved.push(to);
			moving = { to, since: "2026-11-11T21:00:00.000Z" };
		},
		takeUp: (session, to) => takenUp.push(`${session}>${to}`),
		...rest,
	};
	return { facts, moved, takenUp, probed };
}

/** That nothing was moved or started. */
function unchanged(one: Asked): void {
	expect(one.moved).toEqual([]);
	expect(one.takenUp).toEqual([]);
}

describe("/host", () => {
	it("moves the session into the background host unless told otherwise, the take-up started", async () => {
		const one = asked();
		expect(await moveIntoHost("", one.facts)).toBeUndefined();
		expect(one.moved).toEqual(["background"]);
		expect(one.takenUp).toEqual(["01a1>background"]);
		expect(one.probed).toEqual(["/run/user/1000/pi-host/work-background.sock"]);
	});

	it("moves it into the attended host when asked", async () => {
		const one = asked();
		expect(await moveIntoHost(" attended ", one.facts)).toBeUndefined();
		expect(one.moved).toEqual(["attended"]);
		expect(one.takenUp).toEqual(["01a1>attended"]);
	});

	it("starts no take-up when the move itself stopped at once", async () => {
		const one = asked({ move: () => {} });
		expect(await moveIntoHost("", one.facts)).toBeUndefined();
		expect(one.takenUp).toEqual([]);
	});

	it("says how it's used when asked for a host it doesn't know", async () => {
		const one = asked();
		expect(await moveIntoHost("elsewhere", one.facts)).toMatch(
			/^Usage: \/host \[attended\|background\]/,
		);
		unchanged(one);
	});

	it("refuses a conversation already hosted", async () => {
		const one = asked({ hostedIn: () => "work-attended" });
		expect(await moveIntoHost("", one.facts)).toMatch(
			/runs in the work-attended host already/,
		);
		unchanged(one);
	});

	it("refuses while a move already waits", async () => {
		const one = asked({
			moving: () => ({ to: "attended", since: "2026-11-11T20:00:00.000Z" }),
		});
		expect(await moveIntoHost("", one.facts)).toMatch(
			/already moving to the attended host/,
		);
		unchanged(one);
	});

	it("refuses a session with no saved file for a host to take up", async () => {
		const one = asked({ sessionFile: () => undefined });
		expect(await moveIntoHost("", one.facts)).toMatch(/no saved file/);
		unchanged(one);
	});

	it("refuses a window its holder doesn't run itself, since the move would close it", async () => {
		const unheld = asked({
			handOver: () => undefined,
			env: { MYCELIUM_REALM: "work" },
		});
		expect(await moveIntoHost("", unheld.facts)).toMatch(
			/would close it.*nothing holds it/,
		);
		unchanged(unheld);

		const shelled = asked({ handOver: () => undefined, pid: 5151 });
		expect(await moveIntoHost("", shelled.facts)).toMatch(
			/would close it.*a shell/,
		);

		const flagged = asked({ handOver: () => undefined, args: ["--verbose"] });
		expect(await moveIntoHost("", flagged.facts)).toMatch(
			/would close it.*--verbose/,
		);
	});

	it("refuses a personal realm, whose sessions no host runs", async () => {
		const one = asked({
			agents: async () => new Map([["optimus", "pi-claude"]]),
		});
		expect(await moveIntoHost("", one.facts)).toMatch(
			/starts pi-claude for its sessions, which no host runs/,
		);
		unchanged(one);
		expect(one.probed).toEqual([]);
	});

	it("refuses where no realm names a host", async () => {
		const one = asked({ env: { MYCELIUM_WAKE: wake, MYCELIUM_AGAIN: "/a" } });
		expect(await moveIntoHost("", one.facts)).toMatch(/no host here/);
		unchanged(one);
	});

	it("refuses when no host is listening", async () => {
		for (const code of ["ENOENT", "ECONNREFUSED", "ENOTSOCK"]) {
			const one = asked({ failProbe: code });
			expect(await moveIntoHost("", one.facts)).toBe(
				"No work-background host is listening at /run/user/1000/pi-host/work-background.sock, so this session stays here.",
			);
			unchanged(one);
		}
	});

	it("counts a host that answers slowly as there", async () => {
		const one = asked({ failProbe: "ETIMEDOUT" });
		expect(await moveIntoHost("", one.facts)).toBeUndefined();
		expect(one.moved).toEqual(["background"]);
	});
});
