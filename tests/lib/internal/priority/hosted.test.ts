/**
 * The machine queue and the pid marks with several conversations in one
 * host process: each conversation queues its own work, and the files the
 * shaper and the jobs-sorter read by pid stand for every conversation.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withSession } from "../../../../lib/core/session/index.ts";
import {
	awaitedNow,
	tellAwaited,
} from "../../../../lib/internal/priority/awaited.ts";
import { backgroundTurns } from "../../../../lib/internal/priority/background.ts";
import { queueFolder } from "../../../../lib/internal/priority/folder.ts";
import type { Reading } from "../../../../lib/internal/priority/room.ts";
import {
	queuedCommand,
	queueHeavyWork,
} from "../../../../lib/internal/priority/turn.ts";
import { typedTurns } from "../../../../lib/internal/priority/typed.ts";
import { installTestHost } from "../../../support/session-host.ts";

const ROOMY: Reading = {
	availableGib: 40,
	memoryPressure: 0,
	vms: 0,
	cpuPressure: 0,
	cores: 16,
	pressure: { cpu: 0, memory: 0, io: 0 },
};

let root: string;
let host: ReturnType<typeof installTestHost>;
const cleanups: (() => void)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hosted-priority-"));
	host = installTestHost();
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	host.dispose();
	rmSync(root, { recursive: true, force: true });
});

describe("the queue on a host", () => {
	function queueIn(session: string, dir: string) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "queue.json"), "{}\n");
		const folder = queueFolder(dir, {
			isRunning: () => true,
			cgroupOf: () => undefined,
		});
		return withSession(session, () =>
			queueHeavyWork({
				folder,
				session: `session-${session}`,
				room: () => ROOMY,
				cgroupFor: () => undefined,
			}),
		);
	}
	const owners = (dir: string) =>
		readdirSync(dir)
			.filter((name) => name.endsWith(".job"))
			.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")).owner);

	it("queues each conversation's work as its own, and A's end leaves B queueing", () => {
		const aDir = join(root, "a");
		const bDir = join(root, "b");
		const undoA = queueIn("a", aDir);
		queueIn("b", bDir);

		withSession("a", () => queuedCommand("nix build .#tool"));
		withSession("b", () => queuedCommand("nix build .#tool"));
		expect(owners(aDir), "A's job is A's, owned by the host").toEqual([
			{ session: "session-a", pid: host.host.owner.pid },
		]);
		expect(owners(bDir), "B's job is B's").toEqual([
			{ session: "session-b", pid: host.host.owner.pid },
		]);

		undoA();
		expect(
			withSession("a", () => queuedCommand("nix build .#other")),
			"A ended queues nothing",
		).toBe("nix build .#other");
		withSession("b", () => queuedCommand("nix build .#other"));
		expect(owners(bDir), "B still queues after A's end").toHaveLength(2);
	});

	it("hears who is waited on from every conversation's mesh, outside any of them", () => {
		const untellA = tellAwaited(() => new Set(["session-x"]));
		cleanups.push(tellAwaited(() => new Set(["session-y"])));
		expect(
			awaitedNow(),
			"the keeping timer reads it with no conversation",
		).toEqual(new Set(["session-x", "session-y"]));
		untellA();
		expect(awaitedNow(), "A's going takes back only A's").toEqual(
			new Set(["session-y"]),
		);
	});
});

describe("the pid marks on a host", () => {
	const PID = 4343;

	it("keep the typed file while a turn a person typed holds any conversation", () => {
		const dir = join(root, "typed");
		const file = join(dir, String(PID));
		const a = typedTurns(dir, PID);
		const b = typedTurns(dir, PID);
		cleanups.push(a.stop, b.stop);

		a.typed(1);
		b.began(2);
		b.ended();
		expect(existsSync(file), "B's turn ending keeps A's typed mark").toBe(true);
		expect(b.held(), "B itself holds no typed turn").toBe(false);
		b.typed(3);
		a.began(4);
		a.ended();
		expect(existsSync(file), "A's turn ending keeps B's typed mark").toBe(true);
		b.stop();
		expect(existsSync(file), "the last typed turn's end takes it").toBe(false);
	});

	it("keep the background file only while every conversation may yield", () => {
		const dir = join(root, "background");
		const file = join(dir, String(PID));
		const quiet = (now: number) => ({
			editorText: () => "",
			typed: () => false,
			pid: PID,
			quietMs: 10,
			now,
		});
		const a = backgroundTurns(dir, quiet(0));
		const b = backgroundTurns(dir, quiet(0));
		cleanups.push(a.stop, b.stop);

		a.began(100);
		expect(existsSync(file), "A yields while B is the person's").toBe(false);
		b.began(100);
		expect(existsSync(file), "both may yield").toBe(true);
		b.key(101);
		expect(existsSync(file), "a key in B takes it at once").toBe(false);
		b.stop();
		a.settle(200);
		expect(existsSync(file), "with B gone, A alone may yield").toBe(true);
		a.stop();
		expect(existsSync(file), "the last one's end takes it").toBe(false);
	});
});
