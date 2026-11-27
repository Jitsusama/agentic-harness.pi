/**
 * Which mesh asks the machine's node: a session's of the home realm, at
 * its own state dir, hosted or not, unless `PI_MESH_NODE=off` says not
 * to. Every other mesh hears by its folder and never dials a node,
 * whether the home realm's or the session's own.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHost } from "../../../lib/core/session/index.ts";
import { stateDir } from "../../../lib/internal/paths.ts";
import { meshTransport } from "../../../lib/mesh/node-transport.ts";

let root: string;
let servers: Server[];
let clients: Socket[];
let uninstall: (() => void) | undefined;
const stops: (() => void)[] = [];

/** A host in this process, as a pi-durable conversation runs under. */
function host(): () => void {
	return installHost({
		kind: "pi-durable",
		key: "mesh-transport-host",
		owner: { pid: 101, startedAt: 1000, bootId: "boot", startTicks: 10 },
		holds: () => "idle",
		env: () => {
			throw new Error("Mesh transport tests do not consume host env");
		},
		hints: () => ({}),
		close: () => {},
		stamp: () => {},
	});
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ntm-"));
	servers = [];
	clients = [];
	vi.stubEnv("XDG_STATE_HOME", join(root, "state"));
	vi.stubEnv("XDG_RUNTIME_DIR", join(root, "run"));
	vi.stubEnv("MYCELIUM_REALM", "home");
	vi.stubEnv("PI_HOME_REALM", "home");
	vi.stubEnv("PI_MESH_NODE", "");
	uninstall = host();
});

afterEach(async () => {
	for (const stop of stops.splice(0)) stop();
	uninstall?.();
	vi.unstubAllEnvs();
	for (const client of clients) client.destroy();
	await Promise.all(
		servers.map(
			(server) => new Promise<void>((done) => server.close(() => done())),
		),
	);
	rmSync(root, { recursive: true, force: true });
});

/** A node for each of `realms`, each taking every watch, as mycelium's does. */
async function nodes(...realms: string[]): Promise<void> {
	const folder = join(root, "run", "mycelium");
	mkdirSync(folder, { recursive: true });
	for (const realm of realms) {
		const server = createServer((client) => {
			clients.push(client);
			// A transport that stopped closes its end; the test reads what was
			// dialled, not what the node could still write.
			client.on("error", () => undefined);
			client.once("data", () => {
				client.write(`${JSON.stringify({ Ok: "Watching" })}\n`);
			});
		});
		servers.push(server);
		await new Promise<void>((done) =>
			server.listen(join(folder, `${realm}.sock`), done),
		);
	}
}

/** The mesh at `mesh`, watched until the test ends. */
function watched(mesh: string): void {
	mkdirSync(join(mesh, "messages"), { recursive: true });
	stops.push(meshTransport(mesh).watch(() => undefined));
}

/** Long enough for a transport that would ask a node to have dialled it. */
const DIALLED_BY_MS = 500;

/** That no node was dialled, after a transport has had time to dial one. */
async function noneDialled(): Promise<void> {
	// A dial is a local socket's connect, well under this; waiting
	// longer only slows the test, and a missed dial would show as one.
	await new Promise((done) => setTimeout(done, DIALLED_BY_MS));
	expect(clients.length, "no node dialled").toBe(0);
}

describe("which mesh hears through the machine's node", () => {
	it("asks the home realm's node for a hosted session's own mesh", async () => {
		await nodes("home");
		watched(stateDir("mesh-workflow"));
		await vi.waitFor(() => expect(clients.length, "dialled").toBe(1));
	});

	// A pi in a terminal of its own runs as long as a hosted one, and a
	// folder watch would wake it at every message any peer sends.
	it("asks the home realm's node outside a host too", async () => {
		uninstall?.();
		uninstall = undefined;
		await nodes("home");
		watched(stateDir("mesh-workflow"));
		await vi.waitFor(() => expect(clients.length, "dialled").toBe(1));
	});

	it("asks no node for a mesh other than the session's own", async () => {
		await nodes("home");
		watched(join(root, "a-test-mesh"));
		await noneDialled();
	});

	it("asks no node when PI_MESH_NODE is off", async () => {
		vi.stubEnv("PI_MESH_NODE", "off");
		await nodes("home");
		watched(stateDir("mesh-workflow"));
		await noneDialled();
	});

	// Another realm's node may follow a folder of its own, so its session
	// reads its folder, as its presence does, and asks neither node.
	it("asks no node for a session of another realm", async () => {
		vi.stubEnv("MYCELIUM_REALM", "second");
		await nodes("home", "second");
		watched(stateDir("mesh-workflow"));
		await noneDialled();
	});
});
