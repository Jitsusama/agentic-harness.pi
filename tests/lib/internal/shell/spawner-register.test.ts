/**
 * A host telling the node which session a spawner serves: a stand-in
 * node on a socket of its own hears what's said, and a folder stands in
 * for /proc, so nothing real is started or named.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processGlobal } from "../../../../lib/internal/process/process-global.ts";
import {
	NAME_PATIENCE_MS,
	REGISTER_PATIENCE_MS,
	registerSpawner,
	startOf,
} from "../../../../lib/internal/shell/spawner-register.ts";

const SPAWNER = 4242;
const STARTED = 987_654;
const SPAWNED = { pid: SPAWNER, started: STARTED };

/** A short wait for things that must not happen. */
const BRIEFLY_MS = 50;

/** How early a timer may fire, as the wall clock reads it. */
const TIMER_SLACK_MS = 10;

/** A patience shorter than the default, to show the one given is kept. */
const SHORT_PATIENCE_MS = 300;

const made: string[] = [];
const serving: Server[] = [];

/** What the host says before each reason, for the line's shape. */
const LINE =
	"pi-spawner's session isn't named to the mycelium node, so its commands are told no conversation: ";

// Each test starts with the process's once-only reasons empty, so none
// passes for a reason an earlier one used up.
beforeEach(() => {
	processGlobal(
		"agentic-harness.shell/spawner-register-said",
		() => new Set<string>(),
	).clear();
});

afterEach(() => {
	for (const server of serving.splice(0)) server.close();
	for (const folder of made.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

/** A folder of its own, removed after the test. */
function folder(): string {
	const at = mkdtempSync(join(tmpdir(), "spawner-register-"));
	made.push(at);
	return at;
}

/** A /proc holding `pid`, going by `name`, started at `started`. */
function procWith(pid: number, name: string, started = STARTED): string {
	const proc = folder();
	mkdirSync(join(proc, `${pid}`));
	writeFileSync(join(proc, `${pid}`, "comm"), `${name}\n`);
	statOf(proc, pid, name, started);
	return proc;
}

/**
 * Writes `pid`'s stat in `proc`: its state, eighteen fields more, its
 * start as the twenty-second and two after. The name holds a space and a
 * closing bracket, as a process's may.
 */
function statOf(proc: string, pid: number, name: string, started: number) {
	const fields = ["S", ...Array.from({ length: 18 }, (_, at) => `${at}`)];
	writeFileSync(
		join(proc, `${pid}`, "stat"),
		`${pid} (${name} x) y) ${fields.join(" ")} ${started} 0 0\n`,
	);
}

/**
 * A stand-in node: what each connection says, answered with `answer`,
 * never answered for false, or hung up on once heard for "hang up".
 */
function node(answer: string | false | "hang up" = '{"Ok":"Spawned"}') {
	const socket = join(folder(), "node.sock");
	const heard: unknown[] = [];
	const connections: Socket[] = [];
	const server = createServer((connection) => {
		connections.push(connection);
		connection.setEncoding("utf8");
		let said = "";
		connection.on("data", (chunk: string) => {
			said += chunk;
			const end = said.indexOf("\n");
			if (end < 0) return;
			heard.push(JSON.parse(said.slice(0, end)));
			if (answer === "hang up") connection.destroy();
			else if (answer !== false) connection.write(`${answer}\n`);
		});
	});
	serving.push(server);
	const listening = new Promise<void>((ready) =>
		server.listen(socket, () => ready()),
	);
	return { socket, heard, connections, listening };
}

describe("a host telling the node a spawner's session", () => {
	it("says the spawner, the start it was given, and the session", async () => {
		const stand = node();
		await stand.listening;

		await registerSpawner(SPAWNED, "s-one", {
			socket: stand.socket,
			proc: procWith(SPAWNER, "pi-spawner"),
		});

		expect(stand.heard, "what the node heard").toEqual([
			{ Spawned: { pid: SPAWNER, started: STARTED, session: "s-one" } },
		]);
	});

	it("says a refusal on the host's error output, once for each reason", async () => {
		const why = "this host's Node.js can open its inspector";
		const stand = node(JSON.stringify({ Err: why }));
		await stand.listening;
		const said: string[] = [];
		const options = {
			socket: stand.socket,
			proc: procWith(SPAWNER, "pi-spawner"),
			say: (line: string) => said.push(line),
		};

		await registerSpawner(SPAWNED, "s-one", options);
		await registerSpawner(SPAWNED, "s-two", options);

		expect(said, "what the host said").toEqual([
			`pi-spawner's session isn't named to the mycelium node, so its commands are told no conversation: ${why}\n`,
		]);
	});

	it("says a reason once for the process, though pi loads the module afresh for each conversation", async () => {
		const why = "this host's Node.js can open its inspector";
		const stand = node(JSON.stringify({ Err: why }));
		await stand.listening;
		const said: string[] = [];
		const options = {
			socket: stand.socket,
			proc: procWith(SPAWNER, "pi-spawner"),
			say: (line: string) => said.push(line),
		};

		for (const session of ["s-one", "s-two"]) {
			vi.resetModules();
			const loaded = await import(
				"../../../../lib/internal/shell/spawner-register.ts"
			);
			await loaded.registerSpawner(SPAWNED, session, options);
		}

		expect(said, "what the host said").toEqual([`${LINE}${why}\n`]);
	});

	it("says another reason too, but not one only a pid or session sets apart", async () => {
		const said: string[] = [];
		const proc = procWith(SPAWNER, "pi-spawner");
		const say = (line: string) => said.push(line);
		for (const [why, session] of [
			["process 7 is no pi host proving s-three, so it can't say", "s-three"],
			["process 8 is no pi host proving s-four, so it can't say", "s-four"],
			["this machine can't show its processes", "s-three"],
		]) {
			const stand = node(JSON.stringify({ Err: why }));
			await stand.listening;
			await registerSpawner(SPAWNED, `${session}`, {
				socket: stand.socket,
				proc,
				say,
			});
		}

		expect(said, "what the host said").toEqual([
			"pi-spawner's session isn't named to the mycelium node, so its commands are told no conversation: process 7 is no pi host proving s-three, so it can't say\n",
			"pi-spawner's session isn't named to the mycelium node, so its commands are told no conversation: this machine can't show its processes\n",
		]);
	});

	it("says a reason's printable characters only", async () => {
		const stand = node(
			JSON.stringify({
				Err: "a node\u001b[2J\nwrites\u202eback\u2028and\u200bon",
			}),
		);
		await stand.listening;
		const said: string[] = [];

		await registerSpawner(SPAWNED, "s-one", {
			socket: stand.socket,
			proc: procWith(SPAWNER, "pi-spawner"),
			say: (line: string) => said.push(line),
		});

		expect(said, "what the host said").toEqual([
			"pi-spawner's session isn't named to the mycelium node, so its commands are told no conversation: a node?[2J?writes?back?and?on\n",
		]);
	});

	it("says nothing of a node that takes the word", async () => {
		const stand = node();
		await stand.listening;
		const said: string[] = [];

		await registerSpawner(SPAWNED, "s-one", {
			socket: stand.socket,
			proc: procWith(SPAWNER, "pi-spawner"),
			say: (line: string) => said.push(line),
		});

		expect(said, "what the host said").toEqual([]);
	});

	it.each([['{"Ok":"Other"}'], ['{"Err":7}'], ["not an answer"]])(
		"says an answer that neither takes nor refuses the word, as %s",
		async (answer) => {
			const stand = node(answer);
			await stand.listening;
			const said: string[] = [];

			await registerSpawner(SPAWNED, "s-one", {
				socket: stand.socket,
				proc: procWith(SPAWNER, "pi-spawner"),
				say: (line: string) => said.push(line),
			});

			expect(said, "what the host said").toEqual([
				`${LINE}the mycelium node answered in a way this harness can't read\n`,
			]);
		},
	);

	it("waits for the spawner's own name, as one in a scope goes by another first", async () => {
		const stand = node();
		await stand.listening;
		const proc = procWith(SPAWNER, "systemd-run");

		const telling = registerSpawner(SPAWNED, "s-one", {
			socket: stand.socket,
			proc,
		});
		// Nothing is said meanwhile, and nothing is there to wait on for it.
		await new Promise((settle) => setTimeout(settle, BRIEFLY_MS));
		expect(stand.heard, "said before the spawner ran").toEqual([]);
		writeFileSync(join(proc, `${SPAWNER}`, "comm"), "pi-spawner\n");
		await telling;

		expect(stand.heard, "said once it ran").toHaveLength(1);
	});

	it("says the start it was given, never one /proc says meanwhile", async () => {
		const stand = node();
		await stand.listening;
		const proc = procWith(SPAWNER, "systemd-run");

		const telling = registerSpawner(SPAWNED, "s-one", {
			socket: stand.socket,
			proc,
		});
		// Nothing is said meanwhile, and nothing is there to wait on for it.
		await new Promise((settle) => setTimeout(settle, BRIEFLY_MS));
		statOf(proc, SPAWNER, "pi-spawner", STARTED + 1);
		writeFileSync(join(proc, `${SPAWNER}`, "comm"), "pi-spawner\n");
		await telling;

		expect(stand.heard, "what the node heard").toEqual([
			{ Spawned: { pid: SPAWNER, started: STARTED, session: "s-one" } },
		]);
	});

	it("tells nothing of one that never goes by pi-spawner's name, once its patience is spent, and says so", async () => {
		const stand = node();
		await stand.listening;
		const said: string[] = [];
		const began = Date.now();

		await registerSpawner(SPAWNED, "s-one", {
			socket: stand.socket,
			proc: procWith(SPAWNER, "sh"),
			namePatience: SHORT_PATIENCE_MS,
			say: (line: string) => said.push(line),
		});

		expect(stand.heard, "what the node heard").toEqual([]);
		expect(said, "what the host said").toEqual([
			`${LINE}pi-spawner didn't go by its own name within ${SHORT_PATIENCE_MS} ms\n`,
		]);
		expect(Date.now() - began, "how long it waited").toBeGreaterThanOrEqual(
			SHORT_PATIENCE_MS - TIMER_SLACK_MS,
		);
		expect(Date.now() - began, "how long it waited").toBeLessThan(
			NAME_PATIENCE_MS,
		);
	});

	it("says nothing of one /proc doesn't hold, as on a Mac or once it's gone", async () => {
		const stand = node();
		await stand.listening;

		await registerSpawner(SPAWNED, "s-one", {
			socket: stand.socket,
			proc: folder(),
		});

		expect(stand.connections, "connections the node took").toEqual([]);
	});

	it("says nothing where no node is named", async () => {
		const said: string[] = [];

		await registerSpawner(SPAWNED, "s-one", {
			socket: undefined,
			proc: procWith(SPAWNER, "pi-spawner"),
			say: (line: string) => said.push(line),
		});

		expect(said, "what the host said").toEqual([]);
	});

	it("gives up once its patience runs out, when the node never answers, and says so", async () => {
		const stand = node(false);
		await stand.listening;
		const said: string[] = [];
		const options = {
			socket: stand.socket,
			proc: procWith(SPAWNER, "pi-spawner"),
			patience: SHORT_PATIENCE_MS,
			say: (line: string) => said.push(line),
		};
		const began = Date.now();

		await registerSpawner(SPAWNED, "s-one", options);
		const waited = Date.now() - began;
		await registerSpawner(SPAWNED, "s-two", options);

		expect(said, "what the host said, once for both").toEqual([
			`${LINE}the mycelium node didn't answer within ${SHORT_PATIENCE_MS} ms\n`,
		]);
		expect(waited, "how long it waited").toBeGreaterThanOrEqual(
			SHORT_PATIENCE_MS - TIMER_SLACK_MS,
		);
		expect(waited, "how long it waited").toBeLessThan(REGISTER_PATIENCE_MS);
	});

	it("says nothing answered, not that the node was slow, when it hangs up", async () => {
		const stand = node("hang up");
		await stand.listening;
		const said: string[] = [];

		await registerSpawner(SPAWNED, "s-one", {
			socket: stand.socket,
			proc: procWith(SPAWNER, "pi-spawner"),
			say: (line: string) => said.push(line),
		});

		expect(stand.heard, "what the node heard").toHaveLength(1);
		expect(said, "what the host said").toEqual([
			`${LINE}nothing answered at the mycelium node's socket\n`,
		]);
	});

	it("gives up at once where nothing serves the socket, saying nothing", async () => {
		const said: string[] = [];

		await expect(
			registerSpawner(SPAWNED, "s-one", {
				socket: join(folder(), "none.sock"),
				proc: procWith(SPAWNER, "pi-spawner"),
				say: (line: string) => said.push(line),
			}),
		).resolves.toBeUndefined();
		expect(said, "what the host said").toEqual([]);
	});
});

describe("a spawner's start, as /proc says it", () => {
	it("is the stat's twenty-second field, past a name holding spaces", async () => {
		expect(await startOf(SPAWNER, procWith(SPAWNER, "pi spawner"))).toBe(
			STARTED,
		);
	});

	it("is nothing for a process that isn't there", async () => {
		expect(await startOf(SPAWNER, folder())).toBeUndefined();
	});
});
