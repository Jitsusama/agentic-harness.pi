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
	nodeSocket,
	placeAt,
	sessionsAt,
	sessionsFrom,
	startAt,
	startedFrom,
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
		expect(answer.ok).toBe(false);
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
		expect((await placeAt(undefined, [])).ok).toBe(false);
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

describe("where the node's socket is", () => {
	const realm = (name: string) => {
		mkdirSync(join(root, "state", "mycelium"), { recursive: true });
		writeFileSync(join(root, "state", "mycelium", "realm"), `${name}\n`);
	};

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
