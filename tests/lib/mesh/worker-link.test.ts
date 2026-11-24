import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENVELOPE, type Message } from "../../../lib/mesh/message.ts";
import { createPresences, type Presence } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import {
	createWorkerLink,
	eventFrom,
	FIRST_RECENT,
	isBareId,
	keptIn,
	presentedPresences,
	type Refused,
	refusalText,
	relayedTransport,
	replyFrom,
	type WorkerLink,
	workerSocket,
} from "../../../lib/mesh/worker-link.ts";
import { quietFor, until } from "../../support/until.ts";

let dir: string;
let path: string;
let server: Server | undefined;
/** Every connection the stand-in node took, to end after each test. */
let accepted: Socket[] = [];
let link: WorkerLink | undefined;

/** One connection to the stand-in node, and every line it said. */
interface Connection {
	readonly socket: Socket;
	readonly said: unknown[];
}

/** A stand-in worker socket: its connections, in the order they came. */
interface Node {
	readonly connections: Connection[];
}

/** How the stand-in node answers one line on a connection. */
type Answer = (asked: Record<string, unknown>, on: Connection) => string[];

/** The node as agreed: Present, Sent whole, Watching then what it holds. */
const agreed =
	(held: readonly Message[] = []): Answer =>
	(asked) => {
		if ("Presence" in asked) return ['{"Ok":"Present"}'];
		if ("Send" in asked) {
			const sent = asked["Send"];
			const message =
				typeof sent === "object" && sent !== null && "message" in sent
					? sent.message
					: undefined;
			return [JSON.stringify({ Ok: { Sent: message } })];
		}
		if ("Watch" in asked) {
			return [
				'{"Ok":"Watching"}',
				JSON.stringify({ MessagesChanged: { messages: held } }),
			];
		}
		return ['{"Err":"not asked of a worker"}'];
	};

/** Serves `path`, answering each line as `answer` says. */
async function node(answer: Answer): Promise<Node> {
	const heard: Node = { connections: [] };
	server = createServer((socket) => {
		accepted.push(socket);
		const on: Connection = { socket, said: [] };
		heard.connections.push(on);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const line of chunk.split("\n").filter(Boolean)) {
				const asked: Record<string, unknown> = JSON.parse(line);
				on.said.push(asked);
				for (const reply of answer(asked, on)) socket.write(`${reply}\n`);
			}
		});
	});
	const listening = server;
	await new Promise<void>((done) => listening.listen(path, done));
	return heard;
}

/** A presence as a worker's session says it. */
function presence(session = "sess-1"): Presence {
	return {
		session,
		addresses: ["W0RK3R"],
		groups: ["#quest/w0rk3r"],
		worksOn: "work in the cloud",
		owns: [],
		busy: false,
		at: "2026-11-24T06:00:00.000Z",
	};
}

/** A message as the mesh stamps it. */
function message(id: string, text = "hello"): Message {
	return {
		v: ENVELOPE,
		id,
		at: "2026-11-24T06:00:00.000Z",
		from: "W0RK3R",
		to: ["KP0L6A"],
		intent: "fyi",
		text,
		pid: 42,
	};
}

/**
 * An id stamped `ago` before now by `from`, as the mesh mints them: real
 * 13-digit stamps, so a test of take-up orders them as the node will.
 */
function stamped(ago: number, from = "KP0L6A", tail = "aa"): string {
	return `${Date.now() - ago}-${from}-7-${tail}`;
}

/** A message as kept from the watch: from elsewhere, read by address. */
function heardAs(one: Message): Message {
	return { ...one, hosted: true };
}

/** What a session using the link has been handed. */
interface Session {
	readonly kept: Message[];
	readonly refused: Refused[];
	reachedAgain: number;
}

/** Opens a link to the stand-in node, as a worker's session would. */
function linked(
	held: readonly string[] = [],
	keep: (one: Message) => void = () => undefined,
	lastRead?: () => string | undefined,
	mostLine?: number,
): Session {
	const session: Session = { kept: [], refused: [], reachedAgain: 0 };
	link = createWorkerLink({
		socket: path,
		keep: (one) => {
			keep(one);
			session.kept.push(one);
		},
		held: () => held,
		...(lastRead ? { lastRead } : {}),
		refused: (one) => session.refused.push(one),
		reachedAgain: () => {
			session.reachedAgain += 1;
		},
		retryMs: 10,
		...(mostLine === undefined ? {} : { mostLine }),
	});
	return session;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "worker-link-"));
	path = join(dir, "worker.sock");
});
afterEach(async () => {
	link?.close();
	link = undefined;
	const closing = server;
	server = undefined;
	for (const socket of accepted) socket.destroy();
	accepted = [];
	if (closing) {
		await new Promise((done) => closing.close(done));
	}
	rmSync(dir, { recursive: true, force: true });
});

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
		linked();
		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 2);

		link?.present({ ...presence(), busy: true });
		await until(
			"the second presence is said",
			() => (held.connections[0]?.said.length ?? 0) === 2,
		);

		expect(held.connections, "no connection is added for it").toHaveLength(2);
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

	it("tells once a node it can't reach", async () => {
		const session = linked();

		link?.present(presence());
		await until("the refusal is told", () => session.refused.length === 1);
		await quietFor(30, 5);

		expect(session.refused).toHaveLength(1);
		expect(session.refused[0]?.what).toBe("presence");
		expect(session.refused[0]?.why).toContain("can't be reached");
		expect(session.reachedAgain, "nothing was reached").toBe(0);
	});

	it("says once the node it couldn't reach takes its presence", async () => {
		const session = linked();
		link?.present(presence());
		await until("the refusal is told", () => session.refused.length === 1);

		const held = await node(agreed());
		await until("the watch opens", () => held.connections.length === 2);
		await quietFor(10, 3);

		expect(session.reachedAgain).toBe(1);
		expect(session.refused).toHaveLength(1);
	});

	it("takes a send the node already holds as sent", async () => {
		const held = await node((asked, on) =>
			"Send" in asked
				? [
						'{"Err":"3-W0RK3R-42-cc is said already, and a worker can\'t write over it"}',
					]
				: agreed()(asked, on),
		);
		const session = linked();
		link?.present(presence());

		link?.relay(message("3-W0RK3R-42-cc"));
		await until(
			"the send is answered",
			() => (held.connections[0]?.said.length ?? 0) === 2,
		);
		await quietFor(10, 5);

		expect(session.refused).toEqual([]);
	});

	it("tells a send refused as another message said already", async () => {
		await node((asked, on) =>
			"Send" in asked
				? [
						'{"Err":"3-W0RK3R-42-aa is said already, and a worker can\'t write over it"}',
					]
				: agreed()(asked, on),
		);
		const session = linked();
		link?.present(presence());

		link?.relay(message("3-W0RK3R-42-cc"));
		await until("the refusal is told", () => session.refused.length === 1);

		expect(session.refused[0]).toMatchObject({
			what: "send",
			id: "3-W0RK3R-42-cc",
		});
	});

	it("hangs up a connection that says a line too long, reading nothing after it", async () => {
		let flooded = false;
		const held = await node((asked, on) => {
			if ("Presence" in asked && !flooded) {
				flooded = true;
				// Too long, then what would read as the presence's answer.
				return [`${"x".repeat(300)}`, '{"Ok":"Present"}'];
			}
			return agreed()(asked, on);
		});
		const session = linked([], undefined, undefined, 256);

		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 3);
		await quietFor(20, 3);

		expect(session.refused).toEqual([
			{ what: "presence", why: "it said a line over 256 characters" },
		]);
		expect(
			held.connections[1]?.said,
			"the presence goes again on a new connection",
		).toEqual([{ Presence: { presence: presence() } }]);
	});

	it("tells a refusal said again only once", async () => {
		const held = await node(() => ['{"Err":"that session lives elsewhere"}']);
		const session = linked();

		link?.present(presence());
		await until("the first is refused", () => session.refused.length === 1);
		link?.present({ ...presence(), busy: true });
		// Each refused presence is said again on the hold's backoff too.
		await until(
			"the second presence and a retry are answered",
			() => (held.connections[0]?.said.length ?? 0) >= 3,
		);
		await quietFor(10, 5);

		expect(session.refused, "the second refusal is the first's").toHaveLength(
			1,
		);
	});

	it("tells a refusal again once the node takes one of its kind, not another's", async () => {
		const id = "3-W0RK3R-42-cc";
		const held = await node((asked, on) =>
			JSON.stringify(asked).includes(id)
				? ['{"Err":"a worker sends no hold"}']
				: agreed()(asked, on),
		);
		const session = linked();
		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 2);

		link?.relay(message(id));
		await until("the send is refused", () => session.refused.length === 1);
		link?.present({ ...presence(), busy: true });
		link?.relay(message(id));
		await until(
			"all are answered",
			() => (held.connections[0]?.said.length ?? 0) === 4,
		);
		// The node has the 4th line; the link may not yet have its reply.
		await quietFor(10, 3);
		expect(session.refused, "a presence taken clears no send's").toHaveLength(
			1,
		);

		link?.relay(message("4-W0RK3R-42-dd"));
		await until(
			"the taken send is answered",
			() => (held.connections[0]?.said.length ?? 0) === 5,
		);
		await quietFor(10, 3);
		link?.relay(message(id));
		await until("the send is refused again", () => session.refused.length >= 2);
		await quietFor(10, 3);
		expect(session.refused).toHaveLength(2);
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
		// Newest first, so taking the last in the list would miss it.
		linked([newest, stamped(60_000)]);

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
