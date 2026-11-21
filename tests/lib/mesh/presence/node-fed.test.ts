/**
 * Presence on a host, fed by the machine's node: the home realm's
 * presence folder takes its sessions from the node's watch rather than
 * reading the folder, and any other folder, or a session of another
 * realm, reads its folder and never asks the node.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHost } from "../../../../lib/core/session/index.ts";
import { everyRealmsDir } from "../../../../lib/internal/paths.ts";
import { createPresences } from "../../../../lib/mesh/presence.ts";
import { presence } from "./support/presences.ts";

let root: string;
let server: Server | undefined;
let clients: Socket[];
let uninstall: (() => void) | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pnf-"));
	clients = [];
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	vi.stubEnv("XDG_RUNTIME_DIR", join(root, "run"));
	vi.stubEnv("MYCELIUM_REALM", "home");
	vi.stubEnv("PI_HOME_REALM", "home");
	uninstall = installHost({
		kind: "pi-durable",
		key: "presence-node-host",
		owner: { pid: 101, startedAt: 1000, bootId: "boot", startTicks: 10 },
		holds: () => "idle",
		env: () => {
			throw new Error("Presence tests do not consume host env");
		},
		hints: () => ({}),
		close: () => {},
		stamp: () => {},
	});
});

afterEach(async () => {
	uninstall?.();
	vi.unstubAllEnvs();
	for (const client of clients) client.destroy();
	await new Promise<void>((done) => {
		if (server === undefined) done();
		else server.close(() => done());
	});
	server = undefined;
	rmSync(root, { recursive: true, force: true });
});

/** A realm's node, the home one's unless named, saying `sessions` to each watch. */
async function node(sessions: unknown[], realm = "home"): Promise<void> {
	const folder = join(root, "run", "mycelium");
	mkdirSync(folder, { recursive: true });
	server = createServer((client) => {
		clients.push(client);
		client.once("data", () => {
			client.write(
				`${JSON.stringify({ Ok: "Watching" })}\n${JSON.stringify({
					SessionsChanged: { sessions },
				})}\n`,
			);
		});
	});
	const listening = server;
	await new Promise<void>((done) =>
		listening.listen(join(folder, `${realm}.sock`), done),
	);
}

/** The presence folder the home realm's node follows. */
const homeFolder = (): string => {
	const home = everyRealmsDir("state", "mesh-workflow")[0];
	if (home === undefined) throw new Error("no home realm folder");
	return join(home, "presence");
};

describe("presence on a host, where the node follows its folder", () => {
	it("takes the sessions the node says, not the files on disk", async () => {
		const dir = homeFolder();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "on-disk.json"),
			JSON.stringify(presence({ session: "on-disk" })),
		);
		const said = presence({ session: "fed", addresses: ["FED001"] });
		await node([{ id: "fed", address: "FED001", presence: said }]);
		const presences = createPresences(dir);
		presences.all();
		await vi.waitFor(
			() =>
				expect(
					presences.all().map((one) => one.session),
					"the node's sessions alone",
				).toEqual(["fed"]),
			{ timeout: 5000 },
		);
		expect(presences.of("fed"), "the presence the node carried").toEqual(said);
	});

	it("reads any other folder itself, never asking the node", async () => {
		await node([{ id: "fed", address: "FED001", presence: presence() }]);
		const dir = join(root, "elsewhere");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "s-2.json"),
			JSON.stringify(presence({ session: "s-2" })),
		);
		const presences = createPresences(dir);
		presences.all();
		await vi.waitFor(
			() =>
				expect(
					presences.all().map((one) => one.session),
					"read from its folder",
				).toEqual(["s-2"]),
			{ timeout: 5000 },
		);
		// Several of the mirror's polls, any of which would ask a feed.
		await new Promise((done) => setTimeout(done, 1500));
		expect(clients.length, "no watch asked").toBe(0);
	});

	it("reads the home folder itself for a session of another realm", async () => {
		vi.stubEnv("MYCELIUM_REALM", "second");
		// The node this session would ask: its own realm's.
		await node(
			[{ id: "fed", address: "FED001", presence: presence() }],
			"second",
		);
		const dir = homeFolder();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "on-disk.json"),
			JSON.stringify(presence({ session: "on-disk" })),
		);
		const presences = createPresences(dir);
		presences.all();
		// Several of the mirror's polls, any of which would ask a feed.
		await new Promise((done) => setTimeout(done, 1500));
		expect(
			presences.all().map((one) => one.session),
			"read from its folder",
		).toEqual(["on-disk"]);
		expect(clients.length, "no watch asked").toBe(0);
	});
});
