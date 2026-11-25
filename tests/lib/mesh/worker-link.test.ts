import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "../../../lib/mesh/message.ts";
import { createPresences, type Presence } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import {
	eventFrom,
	FIRST_RECENT,
	isBareId,
	keptIn,
	presentedPresences,
	refusalText,
	relayedTransport,
	replyFrom,
} from "../../../lib/mesh/worker-link.ts";
import { workerSocket } from "../../../lib/mesh/worker-socket.ts";
import { quietFor, until } from "../../support/until.ts";
import {
	agreed,
	dir,
	heardAs,
	link,
	linked,
	message,
	node,
	presence,
	stamped,
	useStandInNode,
} from "../../support/worker-node.ts";

useStandInNode();

describe("finding the worker socket", () => {
	it("takes an absolute path the machine names, and nothing else", () => {
		expect(workerSocket({ MYCELIUM_WORKER_SOCKET: "/run/worker.sock" })).toBe(
			"/run/worker.sock",
		);
		expect(workerSocket({ MYCELIUM_WORKER_SOCKET: "worker.sock" })).toBe(
			undefined,
		);
		expect(workerSocket({ MYCELIUM_WORKER_SOCKET: "" })).toBe(undefined);
		expect(workerSocket({})).toBe(undefined);
	});
});

describe("a worker's link to its node", () => {
	it("holds its presence, then watches for its session", async () => {
		const held = await node(agreed([message("1-KP0L6A-7-aa")]));
		const session = linked();

		link?.present(presence());
		await until(
			"the watch hands over what the node holds",
			() => session.kept.length === 1,
		);

		expect(held.connections[0]?.said).toEqual([
			{ Presence: { presence: presence() } },
		]);
		expect(
			held.connections[1]?.said,
			"a first watch asks for the latest",
		).toEqual([
			{ Watch: { session: "sess-1", groups: null, recent: FIRST_RECENT } },
		]);
		expect(session.kept.map(({ id }) => id)).toEqual(["1-KP0L6A-7-aa"]);
	});

	it("opens nothing until it has a presence to hold", async () => {
		const held = await node(agreed());
		linked();

		link?.relay(message("1-W0RK3R-42-aa"));
		link?.present(presence());
		await until(
			"the held send goes",
			() => (held.connections[0]?.said.length ?? 0) === 2,
		);

		expect(
			held.connections[0]?.said,
			"the presence goes before the send",
		).toEqual([
			{ Presence: { presence: presence() } },
			{ Send: { message: message("1-W0RK3R-42-aa") } },
		]);
	});

	it("says a presence again on the connection that holds it", async () => {
		const held = await node(agreed());
		const session = linked();
		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 2);

		link?.present({ ...presence(), busy: true });
		await until(
			"the second presence is said",
			() => (held.connections[0]?.said.length ?? 0) === 2,
		);

		expect(held.connections, "no connection is added for it").toHaveLength(2);
		expect(session.reachedAgain, "nothing was unreachable").toBe(0);
		expect(held.connections[0]?.said[1]).toEqual({
			Presence: { presence: { ...presence(), busy: true } },
		});
	});

	it("keeps each message the watch hears after the first", async () => {
		const held = await node(agreed());
		const session = linked();
		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 2);

		held.connections[1]?.socket.write(
			`${JSON.stringify({ Message: { message: message("2-KP0L6A-7-bb") } })}\n`,
		);
		await until("the message is kept", () => session.kept.length === 1);

		expect(
			session.kept,
			"kept as hosted, so its pid never makes it this session's",
		).toEqual([heardAs(message("2-KP0L6A-7-bb"))]);
	});

	it("tells the session which send the node refused, and why", async () => {
		await node((asked) =>
			"Send" in asked
				? ['{"Err":"a worker sends no hold"}']
				: agreed()(asked, undefined as never),
		);
		const session = linked();
		link?.present(presence());

		link?.relay(message("3-W0RK3R-42-cc"));
		await until("the refusal is told", () => session.refused.length === 1);

		expect(session.refused).toEqual([
			{ what: "send", id: "3-W0RK3R-42-cc", why: "a worker sends no hold" },
		]);
	});

	it("tells the session a refused presence and watches nothing", async () => {
		const held = await node(() => ['{"Err":"that session lives elsewhere"}']);
		const session = linked();

		link?.present(presence());
		await until("the refusal is told", () => session.refused.length === 1);

		await quietFor(10, 5);

		expect(session.refused).toEqual([
			{ what: "presence", why: "that session lives elsewhere" },
		]);
		expect(held.connections, "no watch opens").toHaveLength(1);
	});

	it("says a refused presence again, and watches once the node takes it", async () => {
		let refusals = 1;
		const held = await node((asked, on) => {
			if ("Presence" in asked && refusals > 0) {
				refusals -= 1;
				return ['{"Err":"that session lives elsewhere"}'];
			}
			return agreed()(asked, on);
		});
		const session = linked();

		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 2);

		expect(held.connections[0]?.said, "the same presence, said again").toEqual([
			{ Presence: { presence: presence() } },
			{ Presence: { presence: presence() } },
		]);
		expect(session.refused).toHaveLength(1);
	});

	it("tells a send never written as unsent when it closes", async () => {
		await node(agreed());
		const session = linked();

		link?.relay(message("8-W0RK3R-42-aa"));
		link?.close();

		expect(session.refused).toEqual([
			{
				what: "unsent",
				id: "8-W0RK3R-42-aa",
				why: "the session's link to the node closed before it went",
			},
		]);
	});

	it("goes on keeping after one message it couldn't keep", async () => {
		const held = await node(
			agreed([message("1-KP0L6A-7-aa"), message("2-KP0L6A-7-bb")]),
		);
		const session = linked([], (one) => {
			if (one.id === "1-KP0L6A-7-aa") throw new Error("disk full");
		});

		link?.present(presence());
		await until("the second is kept", () => session.kept.length === 1);

		expect(held.connections, "the watch stays open").toHaveLength(2);
		expect(session.kept.map(({ id }) => id)).toEqual(["2-KP0L6A-7-bb"]);
		expect(session.refused).toEqual([
			{ what: "unkept", id: "1-KP0L6A-7-aa", why: "Error: disk full" },
		]);
	});

	it("never takes up from its own sends, a stamp far ahead or one too short", async () => {
		const held = await node(agreed());
		const elsewhere = stamped(60_000);
		const own = stamped(1000, "W0RK3R", "zz");
		const ahead = stamped(-60 * 60 * 1000, "KP0L6A", "bb");
		linked([elsewhere, own, ahead, "9-KP0L6A-7-cc"]);

		link?.present(presence());
		await until(
			"the watch asks",
			() => (held.connections[1]?.said.length ?? 0) === 1,
		);

		expect(held.connections[1]?.said).toEqual([
			{ Watch: { session: "sess-1", groups: null, since: elsewhere } },
		]);
	});

	it("never takes up from what it hears of its own, far ahead or too short", async () => {
		const elsewhere = stamped(60_000);
		let dropped = false;
		const held = await node((asked, on) => {
			if ("Watch" in asked && !dropped) {
				return [
					'{"Ok":"Watching"}',
					JSON.stringify({
						MessagesChanged: {
							messages: [
								message(elsewhere),
								message(stamped(1000, "W0RK3R", "zz")),
								message(stamped(-60 * 60 * 1000, "KP0L6A", "bb")),
								message("9-KP0L6A-7-cc"),
							],
						},
					}),
				];
			}
			return agreed()(asked, on);
		});
		const session = linked();
		link?.present(presence());
		await until("all four are kept", () => session.kept.length === 4);

		dropped = true;
		held.connections[0]?.socket.destroy();
		await until(
			"the watch asks again",
			() => (held.connections[3]?.said.length ?? 0) === 1,
		);

		expect(held.connections[3]?.said).toEqual([
			{ Watch: { session: "sess-1", groups: null, since: elsewhere } },
		]);
	});

	it("takes up from the last read when it holds nothing from elsewhere, within bounds", async () => {
		const read = stamped(60_000);
		const held = await node(agreed());
		linked([stamped(1000, "W0RK3R", "zz")], undefined, () => read);
		link?.present(presence());
		await until(
			"the watch asks",
			() => (held.connections[1]?.said.length ?? 0) === 1,
		);

		expect(held.connections[1]?.said).toEqual([
			{ Watch: { session: "sess-1", groups: null, since: read } },
		]);
	});

	it("asks for the latest when the last read is far ahead", async () => {
		const held = await node(agreed());
		linked([], undefined, () => stamped(-60 * 60 * 1000));
		link?.present(presence());
		await until(
			"the watch asks",
			() => (held.connections[1]?.said.length ?? 0) === 1,
		);

		expect(held.connections[1]?.said).toEqual([
			{ Watch: { session: "sess-1", groups: null, recent: FIRST_RECENT } },
		]);
	});

	// The node orders since by id as a string, so a short stamp, taken up
	// alone, would sort after every real one and the watch would hear
	// nothing; one padded to now's digits with a zero sorts before every
	// real one, and the node would replay all it holds on each reopen.
	it.each([
		["held", ["9-KP0L6A-7-cc"], undefined],
		["last read", [], "9-KP0L6A-7-cc"],
		["held padded", [`0${Date.now() - 1000}-KP0L6A-7-cc`], undefined],
	] as const)(
		"asks for the latest when the only %s stamp is out of shape",
		async (_, kept, read) => {
			const held = await node(agreed());
			linked([...kept], undefined, () => read);
			link?.present(presence());
			await until(
				"the watch asks",
				() => (held.connections[1]?.said.length ?? 0) === 1,
			);

			expect(held.connections[1]?.said).toEqual([
				{ Watch: { session: "sess-1", groups: null, recent: FIRST_RECENT } },
			]);
		},
	);

	it("opens again after a drop, saying its presence and what went unanswered", async () => {
		let dropped = false;
		const held = await node((asked, on) => {
			// The first send's connection hangs up before it answers.
			if ("Send" in asked && !dropped) {
				dropped = true;
				on.socket.destroy();
				return [];
			}
			return agreed()(asked, on);
		});
		const session = linked();
		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 2);
		const heardId = stamped(1000, "KP0L6A", "dd");
		held.connections[1]?.socket.write(
			`${JSON.stringify({ Message: { message: message(heardId) } })}\n`,
		);
		await until("a message is kept", () => session.kept.length === 1);

		link?.relay(message("5-W0RK3R-42-ee"));
		await until("both open again", () => held.connections.length === 4);
		await until(
			"the send goes again",
			() => (held.connections[2]?.said.length ?? 0) === 2,
		);
		await until(
			"the watch asks again",
			() => (held.connections[3]?.said.length ?? 0) === 1,
		);

		expect(held.connections[2]?.said).toEqual([
			{ Presence: { presence: presence() } },
			{ Send: { message: message("5-W0RK3R-42-ee") } },
		]);
		expect(held.connections[3]?.said, "it takes up from what it kept").toEqual([
			{ Watch: { session: "sess-1", groups: null, since: heardId } },
		]);
		expect(session.refused).toEqual([]);
	});

	it("takes up from the newest message the session holds", async () => {
		const held = await node(agreed());
		const newest = stamped(1000, "KP0L6A", "zz");
		// Newest in the middle, so taking the first or the last would miss it.
		linked([stamped(60_000), newest, stamped(30_000)]);

		link?.present(presence());
		await until(
			"the watch asks",
			() => (held.connections[1]?.said.length ?? 0) === 1,
		);

		expect(held.connections[1]?.said).toEqual([
			{ Watch: { session: "sess-1", groups: null, since: newest } },
		]);
	});

	it("hangs up for good once closed", async () => {
		const held = await node(agreed());
		const session = linked();
		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 2);

		link?.close();
		await until("both hang up", () =>
			held.connections.every(({ socket }) => socket.closed),
		);
		link?.relay(message("6-W0RK3R-42-ff"));
		await quietFor(10, 5);

		expect(held.connections, "nothing opens again").toHaveLength(2);
		expect(session.refused, "a send after the close is told").toEqual([
			{
				what: "unsent",
				id: "6-W0RK3R-42-ff",
				why: "the session's link to the node had closed",
			},
		]);
	});
});

describe("sending through the link", () => {
	it("keeps the message here and relays it as stamped", () => {
		const relayed: Message[] = [];
		const messages = join(dir, "messages");
		const transport = relayedTransport(folderTransport(messages), {
			relay: (one) => relayed.push(one),
		});

		const sent = transport.send({
			from: "W0RK3R",
			to: ["KP0L6A"],
			intent: "fyi",
			text: "hello",
			pid: 42,
		});

		expect(relayed).toEqual([sent]);
		// The folder keeps its staging place beside what it holds.
		expect(
			readdirSync(messages).filter((name) => name.endsWith(".json")),
		).toEqual([`${sent.id}.json`]);
		expect(transport.read(sent.id)).toEqual(sent);
	});
});

describe("what the link keeps and says", () => {
	it("keeps a message heard where the session reads it, once", () => {
		const messages = join(dir, "messages");
		const keep = keptIn(messages);
		const heard = message("1-KP0L6A-7-aa");

		keep(heard);
		// A watch begun again hears its last message again.
		keep({ ...heard, text: "said again" });

		expect(folderTransport(messages).read(heard.id)).toEqual(heard);
		expect(
			readdirSync(messages).filter((name) => name.endsWith(".json")),
		).toEqual([`${heard.id}.json`]);
	});

	it("names no file by an id that isn't a bare stamped id", () => {
		const messages = join(dir, "messages");
		const keep = keptIn(messages);

		expect(() => keep(message("1-KP0L6A-7-../../escape"))).toThrow(
			"no id to name a file by",
		);
		expect(
			readdirSync(dir).filter((name) => name !== "messages"),
			"nothing is written beside the folder",
		).toEqual([]);
	});

	it("reads a bare stamped id as one, and a path or a stamp past time as none", () => {
		expect(isBareId("1764000000000-KP0L6A-7-0a1b2c3d")).toBe(true);
		expect(isBareId("1-KP0L6A-7-../x")).toBe(false);
		expect(isBareId(".hidden")).toBe(false);
		expect(isBareId("9999999999999999-KP0L6A-7-aa")).toBe(false);
	});

	it("says each presence it publishes to the node too", () => {
		const said: Presence[] = [];
		const presences = presentedPresences(
			createPresences(join(dir, "presence")),
			{ present: (one) => said.push(one) },
		);

		presences.publish(presence());
		presences.settle();

		expect(said).toEqual([presence()]);
		expect(presences.of("sess-1")?.addresses).toEqual(["W0RK3R"]);
	});

	it("names the message a refused send was, and what each refusal costs", () => {
		expect(
			refusalText({ what: "send", id: "7-W0RK3R-42-aa", why: "no hold" }),
		).toBe(
			"The node refused message 7-W0RK3R-42-aa, so peers past this machine may not have it: no hold",
		);
		expect(refusalText({ what: "presence", why: "no" })).toContain(
			"peers elsewhere can't find it",
		);
		expect(refusalText({ what: "watch", why: "no" })).toContain(
			"messages from elsewhere don't reach it",
		);
	});
});

describe("reading the node's lines", () => {
	it("reads an Ok as done and an Err as refused with its words", () => {
		expect(replyFrom('{"Ok":"Present"}')).toEqual({ ok: true });
		expect(replyFrom('{"Err":"no"}')).toEqual({ ok: false, why: "no" });
		expect(
			replyFrom('{"Refused":{"code":"not-yours","why":"no such quest"}}'),
			"as a crossing refuses",
		).toEqual({ ok: false, why: "no such quest" });
		expect(replyFrom("garbled").ok).toBe(false);
	});

	it("reads messages from either event, and drops what isn't one", () => {
		const one = message("7-KP0L6A-7-gg");
		expect(eventFrom(JSON.stringify({ Message: { message: one } }))).toEqual({
			kind: "messages",
			messages: [one],
		});
		expect(
			eventFrom(
				JSON.stringify({
					MessagesChanged: {
						messages: [one, { id: "torn" }, message("1-KP0L6A-7-../x")],
					},
				}),
			),
		).toEqual({ kind: "messages", messages: [one] });
		expect(eventFrom('{"Ok":"Watching"}')).toEqual({
			kind: "messages",
			messages: [],
		});
		expect(eventFrom('{"Err":"no presence"}')).toEqual({
			kind: "refused",
			why: "no presence",
		});
	});
});
