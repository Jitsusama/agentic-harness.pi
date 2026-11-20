/**
 * The machine's mycelium node, asked who is there over its socket.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	agentsFrom,
	heldWindowAt,
	heldWindowFrom,
	machineNamesAt,
	machineNamesFrom,
	nodeServes,
	nodeSessionsAt,
	nodeSessionsFrom,
	nodeSocket,
	nodeSockets,
	placeAt,
	placeToStartAt,
	sessionsAt,
	sessionsFrom,
	startAt,
	startedFrom,
	tiesAt,
	tiesFrom,
} from "../../../lib/mesh/node.ts";

let root: string;
let servers: Server[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mesh-node-"));
	servers = [];
});

afterEach(async () => {
	await Promise.all(
		servers.map((server) => new Promise((done) => server.close(done))),
	);
	rmSync(root, { recursive: true, force: true });
});

/** A node at a socket in the test's folder, answering each line it reads. */
async function serving(answer: (line: string) => string | undefined) {
	const socket = join(root, "work.sock");
	const server = createServer((client) => {
		client.setEncoding("utf8");
		client.on("data", (line: string) => {
			const said = answer(line.trim());
			if (said !== undefined) client.write(`${said}\n`);
		});
	});
	servers.push(server);
	await new Promise<void>((listening) => server.listen(socket, listening));
	return socket;
}

const sessions = (...held: object[]) =>
	JSON.stringify({ Ok: { Sessions: held } });

describe("asking the node which window a held session is shown in", () => {
	it("names the window joined to the holder it was asked about", async () => {
		const socket = await serving(() =>
			sessions(
				{
					id: "other",
					held: "aaaa1111",
					window: { terminal: "kitty", id: "3" },
				},
				{
					id: "mine",
					held: "7eff1f9e",
					window: { terminal: "kitty", id: "29", within: "unix:@kitty-5344" },
				},
			),
		);

		expect(await heldWindowAt(socket, "7eff1f9e")).toEqual({
			terminal: "kitty",
			id: "29",
			within: "unix:@kitty-5344",
		});
	});

	it("names none for a holder no window has joined, or an answer it can't read", () => {
		const line = sessions({ id: "mine", held: "7eff1f9e" });

		expect(heldWindowFrom(line, "7eff1f9e")).toBeUndefined();
		expect(heldWindowFrom(line, "nobody00")).toBeUndefined();
		expect(heldWindowFrom("not json", "7eff1f9e")).toBeUndefined();
	});
});

describe("asking the node who is there", () => {
	it("hears every session it holds, by id, as it judges each", async () => {
		const asked: string[] = [];
		const socket = await serving((line) => {
			asked.push(line);
			return sessions(
				{
					id: "far",
					address: "42857FCD",
					machine: "equilibrius",
					state: "busy",
				},
				{
					id: "gone",
					address: "TRIAL1",
					machine: "equilibrius",
					state: "ended",
				},
			);
		});

		const held = await sessionsAt(socket);

		expect(asked, "it asks for the sessions, as the node's wire says").toEqual([
			'"Sessions"',
		]);
		expect(held && Object.fromEntries(held)).toEqual({
			far: "busy",
			gone: "ended",
		});
	});

	it("hears nothing where no node serves", async () => {
		expect(await sessionsAt(join(root, "none.sock"))).toBeUndefined();
		expect(await sessionsAt(undefined)).toBeUndefined();
	});

	it("hears nothing from a node that doesn't answer in time", async () => {
		const socket = await serving(() => undefined);

		expect(await sessionsAt(socket, 50)).toBeUndefined();
	});

	it("takes an answer naming no sessions as no answer, not as nobody", () => {
		expect(sessionsFrom('{"Err":"not a request"}')).toBeUndefined();
		expect(sessionsFrom("not json")).toBeUndefined();
		expect(sessionsFrom(sessions())?.size).toBe(0);
	});

	it("passes over a session in a state it doesn't know", () => {
		const held = sessionsFrom(
			sessions({ id: "odd", state: "dreaming" }, { id: "ok", state: "idle" }),
		);

		expect(held && [...held.keys()]).toEqual(["ok"]);
	});
});

describe("asking the node who is on which machine", () => {
	it("hears each session with its address, machine and state", async () => {
		const socket = await serving((line) =>
			line !== '"Sessions"'
				? undefined
				: sessions(
						{
							id: "far",
							address: "EWUL44",
							machine: "equilibrius",
							state: "idle",
						},
						{ id: "here", machine: "optimus", state: "busy" },
					),
		);

		expect(await nodeSessionsAt(socket)).toEqual([
			{ id: "far", address: "EWUL44", machine: "equilibrius", state: "idle" },
			{ id: "here", machine: "optimus", state: "busy" },
		]);
	});

	it("hears nothing where no node serves or none answers in time", async () => {
		const socket = await serving(() => undefined);

		expect(await nodeSessionsAt(join(root, "none.sock"))).toBeUndefined();
		expect(await nodeSessionsAt(undefined)).toBeUndefined();
		expect(await nodeSessionsAt(socket, 50)).toBeUndefined();
	});

	it("takes an answer naming no sessions as no answer, not as nobody", () => {
		expect(nodeSessionsFrom('{"Err":"not a request"}')).toBeUndefined();
		expect(nodeSessionsFrom("not json")).toBeUndefined();
		expect(nodeSessionsFrom(sessions())).toEqual([]);
	});

	it("keeps a session in a state it doesn't know, without a machine or without an id, as the node said it", () => {
		const held = nodeSessionsFrom(
			sessions(
				{ id: "odd", machine: "optimus", state: "starting" },
				{ id: "nowhere", state: "idle" },
				{ id: "stateless", machine: "optimus" },
				{ machine: "optimus", state: "idle" },
			),
		);

		expect(held).toEqual([
			{ id: "odd", machine: "optimus", state: "starting" },
			{ id: "nowhere", state: "idle" },
			{ id: "stateless", machine: "optimus", state: "unknown" },
			{ id: "", machine: "optimus", state: "idle" },
		]);
	});
});

describe("whether a node serves at a socket", () => {
	it("says so of one listening", async () => {
		const socket = await serving(() => undefined);
		expect(await nodeServes(socket), "a listening socket serves").toBe(true);
	});

	it("says not where nothing is, or only a file", async () => {
		const file = join(root, "plain.sock");
		writeFileSync(file, "");
		expect(
			await nodeServes(join(root, "none.sock")),
			"a path with nothing at it isn't served",
		).toBe(false);
		expect(await nodeServes(file), "a plain file isn't served").toBe(false);
	});
});

describe("asking the node to start a session held", () => {
	const start = {
		machine: "equilibrius",
		folder: "src/core.nix",
		command: ["pi"],
	};

	it("asks as the node's wire says and hears where and how to join it", async () => {
		const asked: unknown[] = [];
		const started = {
			machine: "equilibrius",
			held: "c97b4852",
			folder: "/Users/joel/src/core.nix",
			attach: [
				"ssh",
				"-t",
				"--",
				"equilibrius",
				"mycelium",
				"attach",
				"c97b4852",
			],
		};
		const socket = await serving((line) => {
			asked.push(JSON.parse(line));
			return JSON.stringify({ Ok: { Started: started } });
		});

		const answer = await startAt(socket, start);

		expect(asked).toEqual([
			{
				Start: {
					work: { needs: [{ machine: "equilibrius" }] },
					folder: "src/core.nix",
					command: ["pi"],
				},
			},
		]);
		expect(answer).toEqual({ ok: true, started });
	});

	it("asks for what else the machine must be, with the machine pinned", async () => {
		const asked: unknown[] = [];
		const socket = await serving((line) => {
			asked.push(JSON.parse(line));
			return '{"Err":"refused"}';
		});

		await startAt(socket, {
			...start,
			needs: [
				{ kind: "reach", value: "home" },
				{ kind: "machine", value: "equilibrius" },
			],
		});

		expect(asked).toMatchObject([
			{
				Start: {
					work: { needs: [{ reach: "home" }, { machine: "equilibrius" }] },
				},
			},
		]);
	});

	it("hears the node's reason when nothing starts", () => {
		expect(
			startedFrom('{"Err":"nowhere: optimus isn\'t equilibrius"}'),
		).toEqual({
			ok: false,
			reason: "nowhere: optimus isn't equilibrius",
		});
	});

	it("sends the asker's name for the start, under which an ask again joins it", async () => {
		const asked: unknown[] = [];
		const socket = await serving((line) => {
			asked.push(JSON.parse(line));
			return '{"Err":"refused"}';
		});

		await startAt(socket, { ...start, once: "01JSTART" });

		expect(asked).toMatchObject([{ Start: { once: "01JSTART" } }]);
	});

	it("says a start the node took and never answered may still land", async () => {
		const socket = await serving(() => undefined);

		const answer = await startAt(socket, start, 500);

		expect(answer).toMatchObject({ ok: false, mayLand: true });
		expect(answer.ok || answer.reason).toContain(
			"took the ask and answered nothing within 0.5 s",
		);
	});

	it("says a start the node took and hung up on may still land", async () => {
		const socket = join(root, "hangs-up.sock");
		const server = createServer((client) => {
			client.on("data", () => client.destroy());
		});
		servers.push(server);
		await new Promise<void>((listening) => server.listen(socket, listening));

		const answer = await startAt(socket, start);

		expect(answer).toMatchObject({ ok: false, mayLand: true });
		expect(answer.ok || answer.reason).toContain(
			"took the ask and hung up before it answered",
		);
	});

	it("says why when no node answers, or none is named", async () => {
		const none = join(root, "none.sock");
		expect(await startAt(none, start)).toEqual({
			ok: false,
			reason: `no mycelium node answered at ${none}`,
		});
		expect(await startAt(undefined, start)).toEqual({
			ok: false,
			reason: "no mycelium realm is named here, so there is no node to ask",
		});
	});

	it("takes an answer it can't read as not started", () => {
		const answer = startedFrom('{"Ok":{"Started":{"machine":"x"}}}');
		expect(answer).toMatchObject({ ok: false });
	});
});

describe("asking the node where work goes", () => {
	it("asks as the node's wire says and hears the machine it chose", async () => {
		const asked: unknown[] = [];
		const socket = await serving((line) => {
			asked.push(JSON.parse(line));
			return JSON.stringify({
				Ok: { Placement: { placed: { machine: "optimus", passed: [] } } },
			});
		});

		const answer = await placeAt(socket, [{ kind: "reach", value: "home" }]);

		expect(asked).toEqual([{ Place: { needs: [{ reach: "home" }] } }]);
		expect(answer).toEqual({ ok: true, machine: "optimus" });
	});

	it("says why when no node answers, or none is named", async () => {
		const none = join(root, "none.sock");
		expect(await placeAt(none, [])).toEqual({
			ok: false,
			reason: `no mycelium node answered at ${none}`,
		});
		expect(await placeAt(undefined, [])).toMatchObject({ ok: false });
	});
});

describe("asking the node where work a spawn starts goes", () => {
	it("asks for a place it counts as a start here", async () => {
		const asked: unknown[] = [];
		const socket = await serving((line) => {
			asked.push(JSON.parse(line));
			return JSON.stringify({
				Ok: { Placement: { placed: { machine: "optimus", passed: [] } } },
			});
		});

		const answer = await placeToStartAt(socket, [
			{ kind: "reach", value: "home" },
		]);

		expect(asked).toEqual([{ PlaceToStart: { needs: [{ reach: "home" }] } }]);
		expect(answer).toEqual({ ok: true, machine: "optimus" });
	});

	it("asks a node that doesn't know that request where, as before", async () => {
		const asked: unknown[] = [];
		const socket = await serving((line) => {
			const ask = JSON.parse(line);
			asked.push(ask);
			return JSON.stringify(
				"PlaceToStart" in ask
					? {
							Err: "not a request: unknown variant `PlaceToStart`, expected one of `Sessions`, `Place`",
						}
					: {
							Ok: {
								Placement: { placed: { machine: "optimus", passed: [] } },
							},
						},
			);
		});

		const answer = await placeToStartAt(socket, [
			{ kind: "reach", value: "home" },
		]);

		expect(asked).toEqual([
			{ PlaceToStart: { needs: [{ reach: "home" }] } },
			{ Place: { needs: [{ reach: "home" }] } },
		]);
		expect(answer).toEqual({ ok: true, machine: "optimus" });
	});

	it("says why a node refuses, asking nothing more", async () => {
		for (const refusal of [
			"the asker can't be told",
			// Another request it doesn't know is not this one.
			"not a request: unknown variant `Need`, expected one of `Place`",
			// Words of the asker's own echoed back are not the node's own.
			"no machine takes it: unknown variant `PlaceToStart`",
		]) {
			const asked: unknown[] = [];
			const socket = await serving((line) => {
				asked.push(JSON.parse(line));
				return JSON.stringify({ Err: refusal });
			});

			const answer = await placeToStartAt(socket, []);

			expect(asked, refusal).toHaveLength(1);
			expect(answer).toEqual({ ok: false, reason: refusal });
			await new Promise((closed) => servers.pop()?.close(closed));
		}
	});

	it("says why when no realm is named", async () => {
		expect(await placeToStartAt(undefined, [])).toMatchObject({ ok: false });
	});
});

describe("asking the node whom a cell is tied to", () => {
	it("says hello before it lists, as the daemon interface wants", async () => {
		const asked: unknown[] = [];
		const socket = await serving((line) => {
			const ask = JSON.parse(line);
			asked.push(ask);
			return JSON.stringify(
				ask.ask === "hello"
					? { id: ask.id, version: 1 }
					: { id: ask.id, records: [] },
			);
		});

		expect(await tiesAt(socket, ["85PKB2"])).toEqual([]);
		// The node adds only key and kind: asked without heard, the live
		// node of 17 November answered 1268 ties and every one was dropped.
		expect(asked).toEqual([
			{ id: 1, ask: "hello" },
			{
				id: 2,
				ask: "list",
				kind: "tie",
				fields: ["hour", "today", "intents", "strength", "heard"],
			},
		]);
	});

	it("hears none from a node that speaks no daemon interface, or none at all", async () => {
		const old = await serving(() => JSON.stringify({ Err: "not a request" }));

		expect(await tiesAt(old, ["85PKB2"])).toBeUndefined();
		expect(await tiesAt(join(root, "none.sock"), ["85PKB2"])).toBeUndefined();
		expect(await tiesAt(undefined, ["85PKB2"])).toBeUndefined();
	});

	it("takes a node refusing the kind, as one before ties, as no ties to say", () => {
		const refused = JSON.stringify({ id: 2, error: "no kind tie" });

		expect(tiesFrom(refused, ["85PKB2"], 0)).toBeUndefined();
		expect(tiesFrom("not json", ["85PKB2"], 0)).toBeUndefined();
	});

	it("keeps only ties with an end it goes by, its own counts first", () => {
		const line = JSON.stringify({
			id: 2,
			records: [
				{
					key: "tie:6849CB76~WCJQSG",
					heard: 0,
					hour: [1, 2],
					today: [3, 4],
					intents: ["fyi"],
					strength: 2,
				},
				{
					key: "tie:KP0L6A~WCJQSG",
					heard: 0,
					hour: [1, 1],
					today: [1, 1],
					intents: [],
					strength: 9,
				},
				{ key: "tie:6849CB76", heard: 0, hour: 1, today: 3, ties: 1 },
				{
					key: "tie:85PKB2~X",
					heard: 0,
					hour: [1],
					today: [1, 1],
					strength: 1,
				},
			],
		});

		expect(tiesFrom(line, ["85PKB2", "6849cb76"], 0)).toEqual([
			{
				other: "WCJQSG",
				strength: 2,
				hour: [1, 2],
				today: [3, 4],
				intents: ["fyi"],
			},
		]);
	});
});

describe("what starts an agent session on each machine", () => {
	it("is the one command each machine declares for the node's realm", () => {
		// As optimus's personal node answered on 30 October.
		const line = JSON.stringify({
			Ok: {
				Machines: [
					{ name: "optimus", declared: { agents: { personal: "pi-claude" } } },
					{ name: "penelope", declared: null },
					{ name: "methuselah", declared: { agents: {} } },
					{ name: "two", declared: { agents: { a: "x", b: "y" } } },
				],
			},
		});
		expect([...agentsFrom(line)]).toEqual([["optimus", "pi-claude"]]);
		expect(agentsFrom("not json").size).toBe(0);
	});
});

describe("which machines the realm holds", () => {
	it("is every machine the node names, sessions on it or not", async () => {
		const socket = await serving((line) =>
			line !== '"Machines"'
				? undefined
				: JSON.stringify({
						Ok: {
							Machines: [
								{ name: "optimus", declared: null },
								{ name: "penelope" },
								{ declared: null },
								{ name: "" },
								{ name: "two words" },
							],
						},
					}),
		);

		expect(await machineNamesAt(socket)).toEqual(["optimus", "penelope"]);
	});

	it("is nothing where no node answers, or its answer names none", async () => {
		expect(await machineNamesAt(undefined)).toBeUndefined();
		expect(machineNamesFrom("not json")).toBeUndefined();
		expect(machineNamesFrom('{"Err":"no"}')).toBeUndefined();
	});
});

describe("where the node's socket is", () => {
	const realm = (name: string) => {
		mkdirSync(join(root, "state", "mycelium"), { recursive: true });
		writeFileSync(join(root, "state", "mycelium", "realm"), `${name}\n`);
	};

	it("is one for each realm the machine runs a node in, the session's own first though it has none yet", () => {
		const run = join(root, "run");
		mkdirSync(join(run, "mycelium", "work.held"), { recursive: true });
		writeFileSync(join(run, "mycelium", "personal.sock"), "");
		writeFileSync(join(run, "mycelium", "reached.json"), "{}");

		expect(
			nodeSockets({
				XDG_RUNTIME_DIR: run,
				XDG_STATE_HOME: join(root, "state"),
				MYCELIUM_REALM: "work",
			}),
		).toEqual([
			join(run, "mycelium", "work.sock"),
			join(run, "mycelium", "personal.sock"),
		]);
	});

	it("is none where no realm is named", () => {
		expect(
			nodeSockets({
				XDG_RUNTIME_DIR: join(root, "run"),
				XDG_STATE_HOME: join(root, "state"),
			}),
		).toEqual([]);
	});

	it("is in the login's runtime folder, for the session's own realm though the node first kept another", () => {
		// A machine in two realms runs a node for each, and the kept realm
		// is only the first's: a personal session asks the personal node.
		realm("work");

		expect(
			nodeSocket({
				XDG_RUNTIME_DIR: "/run/user/1000",
				XDG_STATE_HOME: join(root, "state"),
				MYCELIUM_REALM: "personal",
			}),
		).toBe("/run/user/1000/mycelium/personal.sock");
	});

	it("is for the realm the node kept when the session names none", () => {
		realm("work");

		expect(
			nodeSocket({
				XDG_RUNTIME_DIR: "/run/user/1000",
				XDG_STATE_HOME: join(root, "state"),
			}),
		).toBe("/run/user/1000/mycelium/work.sock");
	});

	it("is for the login's realm before any node has run", () => {
		expect(
			nodeSocket({
				XDG_RUNTIME_DIR: "/run/user/1000",
				XDG_STATE_HOME: join(root, "state"),
				MYCELIUM_REALM: "personal",
			}),
		).toBe("/run/user/1000/mycelium/personal.sock");
	});

	it("is nowhere while no realm is named", () => {
		expect(
			nodeSocket({
				XDG_RUNTIME_DIR: "/run/user/1000",
				XDG_STATE_HOME: join(root, "state"),
			}),
		).toBeUndefined();
	});
});
