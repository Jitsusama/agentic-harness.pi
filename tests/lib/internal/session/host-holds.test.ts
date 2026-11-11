/**
 * Which host holds a conversation, open in its list or kept on its
 * roster, so readers judge a hosted conversation by its host rather than
 * by the pid an old record names.
 */
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostRegistry } from "../../../../lib/core/session/host.ts";
import type { TickedOwner } from "../../../../lib/internal/process-ticks.ts";
import {
	ATTACH_FAILED_ENV,
	attachWords,
	conversationsIn,
	heldByHost,
	holdOf,
	hostHold,
	RELEASED_EXIT,
	rosterHolds,
	viewingWords,
} from "../../../../lib/internal/session/host-holds.ts";

const kept = "01a1be5c-fff0-70a1-9301-f505d5634bf6";
const open = "019e0c11-2b2c-7bd5-9e04-1c3c0a5b7a10";
const loose = "019e0c11-2b2c-7bd5-9e04-1c3c0a5b7a11";
let root: string;
let dir: string;
let rosters: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "host-holds-"));
	dir = join(root, "hosts");
	rosters = join(root, "host-rosters");
	mkdirSync(dir, { recursive: true });
	mkdirSync(rosters, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const running = { pid: 4100, startedAt: 1_794_370_632_830, startTicks: 141 };
const standing = async (owner: TickedOwner) =>
	owner.pid === running.pid ? ("running" as const) : ("gone" as const);

/** Write a host's list as session-host.ts does. */
function list(key: string, owner: TickedOwner, sessions: string[]): void {
	const registry: HostRegistry = {
		key,
		owner,
		sessions: sessions.map((id) => ({
			id,
			state: "idle",
			since: "2026-11-11T00:30:00.000Z",
		})),
	};
	writeFileSync(
		join(dir, `${owner.pid}-${owner.startTicks}.json`),
		JSON.stringify(registry),
	);
}

/** Write a host's roster as roster.ts does, each working where `cwdOf` says. */
function roster(
	key: string,
	sessions: string[],
	cwdOf: (sessionId: string) => string = () => "/home/someone/src/core.nix",
): void {
	writeFileSync(
		join(rosters, `${key}.json`),
		JSON.stringify({
			v: 1,
			key,
			sessions: sessions.map((sessionId) => ({
				sessionId,
				file: `/home/someone/.pi/sessions/${sessionId}.jsonl`,
				cwd: cwdOf(sessionId),
				attended: false,
				since: "2026-11-11T00:30:00.000Z",
			})),
		}),
	);
}

describe("the conversations a roster keeps working in a folder", () => {
	it("are those whose folder is it or inside it, through links too", () => {
		const scratch = join(root, "QEST-20261111-AAAAAA");
		const clone = join(scratch, "clone");
		const beside = join(root, "QEST-20261111-AAAAAA-old");
		mkdirSync(clone, { recursive: true });
		mkdirSync(beside, { recursive: true });
		const link = join(root, "pi-quest-link");
		symlinkSync(scratch, link);
		const cwds: Record<string, string> = {
			[kept]: clone,
			[open]: join(link, "clone"),
			[loose]: beside,
		};
		roster("work-background", [kept, loose], (id) => cwds[id] ?? "");
		roster("work-attended", [open], (id) => cwds[id] ?? "");

		expect(conversationsIn(scratch, rosters).sort()).toEqual(
			[kept, open].sort(),
		);
		expect(
			conversationsIn(join(root, "elsewhere"), rosters),
			"a folder nobody works in",
		).toEqual([]);
	});

	it("are none where no roster folder is", () => {
		expect(conversationsIn(root, join(root, "missing"))).toEqual([]);
	});
});

describe("the conversations the rosters keep", () => {
	it("maps each to the host keeping it", () => {
		roster("work-background", [kept]);
		roster("work-attended", [open]);

		expect(rosterHolds(rosters)).toEqual(
			new Map([
				[kept, "work-background"],
				[open, "work-attended"],
			]),
		);
	});

	it("keeps nothing from a malformed roster or a missing folder", () => {
		writeFileSync(join(rosters, "work-background.json"), "{not json");

		expect(rosterHolds(rosters).size).toBe(0);
		expect(rosterHolds(join(root, "none")).size).toBe(0);
	});
});

describe("the host holding a conversation", () => {
	it("is open in a running host whose list names it", async () => {
		list("work-background", running, [open]);

		expect(await hostHold(open, { dir, standing, rosters })).toEqual({
			key: "work-background",
			realm: "work",
			open: true,
		});
	});

	it("is kept by a roster while its host is down", async () => {
		list("work-background", { ...running, pid: 4300 }, [kept]);
		roster("work-background", [kept]);

		expect(await hostHold(kept, { dir, standing, rosters })).toEqual({
			key: "work-background",
			realm: "work",
			open: false,
		});
	});

	it("is none when no list or roster names it", async () => {
		list("work-background", running, [open]);
		roster("work-background", [kept]);

		expect(await hostHold(loose, { dir, standing, rosters })).toBeUndefined();
	});
});

describe("reaching a held conversation", () => {
	it("names the realm, host and session to attach to", () => {
		expect(attachWords(holdOf("work-attended", true), open)).toEqual([
			"mycelium",
			"--realm",
			"work",
			"attach",
			"--host",
			"work-attended",
			"--session",
			open,
		]);
	});

	it("says whether the host has it open or takes it up as it starts", () => {
		const said = heldByHost(kept, holdOf("work-background", false));

		expect(said).toContain("kept by the work-background host");
		expect(said).toContain(
			`mycelium --realm work attach --host work-background --session ${kept}`,
		);
		expect(heldByHost(open, holdOf("work-background", true))).toContain(
			"is open in the work-background host",
		);
	});
});

describe("viewing a hosted conversation in a window", () => {
	/**
	 * Run the viewing words with a stand-in mycelium that keeps the words
	 * it was given and leaves as `code` says, and words after it that say
	 * whether the attach failed, and with what.
	 */
	function viewed(code: number): {
		status: number | null;
		out: string;
		attached: string[];
	} {
		const bin = join(root, "bin");
		const attached = join(root, "attached");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "mycelium"),
			`#!/bin/sh\nprintf '%s\\n' "$@" > '${attached}'\nexit ${code}\n`,
			{ mode: 0o755 },
		);
		const words = viewingWords(holdOf("work-attended", true), open, [
			"sh",
			"-c",
			`echo "carried on after ${"$"}{${ATTACH_FAILED_ENV}:-a release}"`,
		]);
		// One left set from an earlier failure, which a release must clear.
		const ran = spawnSync(words[0] ?? "", words.slice(1), {
			encoding: "utf8",
			env: {
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				[ATTACH_FAILED_ENV]: "9",
			},
		});
		return {
			status: ran.status,
			out: ran.stdout,
			attached: readFileSync(attached, "utf8").trim().split("\n"),
		};
	}

	it("carries on as what it was released to once the host lets it go", () => {
		const ran = viewed(RELEASED_EXIT);

		expect(ran.attached).toEqual(
			attachWords(holdOf("work-attended", true), open).slice(1),
		);
		expect(ran.out).toBe("carried on after a release\n");
		expect(ran.status).toBe(0);
	});

	it("carries on, saying how attach failed, when attach fails, rather than closing the window", () => {
		expect(viewed(1)).toMatchObject({ out: "carried on after 1\n", status: 0 });
	});

	it("ends as attach did when its person left", () => {
		expect(viewed(0)).toMatchObject({ out: "", status: 0 });
	});

	it("keeps the session's id beside --session, as the node finds it", () => {
		const words = viewingWords(holdOf("work-attended", true), open, []);

		expect(words[words.indexOf("--session") + 1]).toBe(open);
	});
});
