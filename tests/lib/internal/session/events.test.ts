/**
 * Events: what a session says it did in its repositories and quests,
 * which stand in its presence, and what a reader keeps.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	EVENTS_FOR_MS,
	isSessionEvent,
	MOST_EVENTS,
	onDid,
	recentEvents,
	type SessionEvent,
	sayDid,
	stageTitle,
	TITLE_MOST,
} from "../../../../lib/internal/session/events.ts";
import { localPeer } from "../../../../lib/mesh/peer.ts";
import { createPresences } from "../../../../lib/mesh/presence.ts";

const noon = Date.parse("2026-11-15T12:00:00.000Z");
const event = (n: number, minutesAgo = n): SessionEvent => ({
	at: new Date(noon - minutesAgo * 60_000).toISOString(),
	kind: "commit",
	where: "github:Jitsusama/agentic-harness.pi",
	title: `commit ${n}`,
});

/** A bus as pi's: emit and on, with a disposer. */
function bus() {
	const emitter = new EventEmitter();
	return {
		emit: (channel: string, data: unknown) => emitter.emit(channel, data),
		on: (channel: string, handler: (data: unknown) => void) => {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
	};
}

describe("an event said on the bus", () => {
	it("is heard with its time, kind, place and a title on one line", () => {
		const said = bus();
		const heard: SessionEvent[] = [];
		onDid(said, (one) => heard.push(one));
		sayDid(
			said,
			{
				kind: "pr",
				where: " github:o/r ",
				title: "Spawn\n  Where There's Room",
			},
			noon,
		);
		expect(heard).toEqual([
			{
				at: "2026-11-15T12:00:00.000Z",
				kind: "pr",
				where: "github:o/r",
				title: "Spawn Where There's Room",
			},
		]);
	});

	it("cuts a long title to what mycelium keeps", () => {
		const said = bus();
		const heard: SessionEvent[] = [];
		onDid(said, (one) => heard.push(one));
		sayDid(said, {
			kind: "merge",
			where: "github:o/r",
			title: "é".repeat(200),
		});
		expect([...(heard[0]?.title ?? "")], "cut by characters").toHaveLength(
			TITLE_MOST,
		);
	});

	it("is not said with nowhere to name, nor with no bus", () => {
		const said = bus();
		const heard: SessionEvent[] = [];
		onDid(said, (one) => heard.push(one));
		sayDid(said, { kind: "push", where: "  ", title: "topic" });
		sayDid(undefined, { kind: "push", where: "github:o/r", title: "topic" });
		expect(heard).toEqual([]);
	});

	it("is not heard when it isn't one", () => {
		const said = bus();
		const heard: SessionEvent[] = [];
		onDid(said, (one) => heard.push(one));
		said.emit("session:did:v1", { ...event(0), kind: "lunch" });
		said.emit("session:did:v1", { ...event(0), at: "noon" });
		said.emit("session:did:v1", { ...event(0), where: "" });
		expect(heard).toEqual([]);
		expect(isSessionEvent(event(0)), "a whole one is").toBe(true);
	});
});

describe("the events that stand", () => {
	it("are the hour's newest twenty, newest first", () => {
		const many = Array.from({ length: 30 }, (_, n) => event(n, n));
		const stale = event(99, EVENTS_FOR_MS / 60_000 + 1);
		const kept = recentEvents([stale, ...many].reverse(), noon);
		expect(kept).toHaveLength(MOST_EVENTS);
		expect(kept.map((one) => one.title)).toEqual(
			many.slice(0, MOST_EVENTS).map((one) => one.title),
		);
	});
});

describe("a quest action's event", () => {
	it("names the document and the stage it moved to, and only for a stage", () => {
		expect(stageTitle("draft", "PLAN-20261115-AAAAAA")).toBe(
			"PLAN-20261115-AAAAAA was drafted",
		);
		expect(stageTitle("conclude", undefined)).toBe("A document was concluded");
		expect(stageTitle("tick", "PLAN-1")).toBeUndefined();
	});
});

describe("a peer's events", () => {
	let root: string;
	const session = "01a1e0aa-0000-7000-8000-000000000254";

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "mesh-events-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function peer(now = Date.now) {
		const presences = createPresences(join(root, "presence"));
		const made = localPeer({
			session,
			cwd: root,
			records: {
				sessions: join(root, "sessions"),
				quests: join(root, "quests"),
			},
			presences,
			now,
		});
		return { peer: made, presences };
	}

	it("are left out until it does something, then said newest first", () => {
		const { peer: one, presences } = peer(() => noon);
		expect(presences.of(session)?.events, "nothing done yet").toBeUndefined();
		one.did(event(2));
		one.did(event(1));
		expect(presences.of(session)?.events?.map((e) => e.title)).toEqual([
			"commit 1",
			"commit 2",
		]);
		one.dispose();
	});

	it("outlast a reload, as its presence carried them", () => {
		const first = peer(() => noon);
		first.peer.did(event(1));
		first.peer.dispose();
		const again = peer(() => noon);
		expect(again.peer.events.map((e) => e.title)).toEqual(["commit 1"]);
		again.peer.dispose();
	});

	it("are dropped one by one by a reader when they aren't events", () => {
		const { peer: one, presences } = peer(() => noon);
		const own = presences.of(session);
		if (own === undefined) throw new Error("the peer published nothing");
		const file = join(root, "presence", `${session}.json`);
		writeFileSync(
			file,
			JSON.stringify({ ...own, events: [event(1), { kind: "push" }] }),
		);
		expect(presences.of(session)?.events, "the whole one kept").toEqual([
			event(1),
		]);
		one.dispose();
	});
});
