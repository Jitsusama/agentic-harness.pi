/**
 * A fenced conversation's servers are its own.
 *
 * A server started in one session's fence reads what that fence lets
 * through, so no other session's call, fenced or not, is answered by
 * it, and none of its calls by another's.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	createStandaloneBackend,
	type LspFence,
	type StandaloneBackend,
} from "../../../../lib/core/lsp/index.ts";

const started = vi.hoisted(
	() =>
		[] as {
			fence: string | undefined;
			search: ReturnType<typeof vi.fn>;
			disposed: ReturnType<typeof vi.fn>;
			hold: { until?: Promise<void> };
			/** Ends the server, as its process dying would. */
			gone: () => void;
		}[],
);
/** A start that waits on `next`, once, and fails as it does. */
const pending = vi.hoisted(() => ({}) as { next?: Promise<never> });
vi.mock("../../../../lib/core/lsp/standalone/server.ts", () => ({
	StandaloneServer: {
		async start(
			_config: unknown,
			root: string,
			_binary: string,
			fence?: { key: string },
		) {
			const waited = pending.next;
			pending.next = undefined;
			await waited;
			const search = vi.fn(async () => []);
			const disposed = vi.fn(async () => {});
			const hold: { until?: Promise<void> } = {};
			const ends: (() => void)[] = [];
			const gone = () => {
				for (const end of ends) end();
			};
			started.push({ fence: fence?.key, search, disposed, hold, gone });
			return {
				root,
				onGone(end: () => void) {
					ends.push(end);
				},
				diagnose: async () => {
					await hold.until;
					return [];
				},
				workspaceSymbols: search,
				syncDocument() {},
				dispose: disposed,
			};
		},
	},
}));

let dir: string | undefined;
let backend: StandaloneBackend | undefined;
afterEach(async () => {
	await backend?.dispose();
	if (dir) rmSync(dir, { recursive: true, force: true });
	started.length = 0;
});

const fence = (key: string): LspFence => ({
	key,
	launch: async () => ({ text: "true", env: {} }),
	refuses: () => undefined,
});

/** A fake server for `.ts` files under a root holding `marker`. */
const fake = (name: string) => ({
	name,
	command: process.execPath,
	args: [],
	fileTypes: [".ts"],
	rootMarkers: ["marker"],
});

/** A backend over fake servers, one unless `also` names a second, whose root holds `one.ts`. */
const backendWithFile = (
	also?: string,
): { file: string; pool: StandaloneBackend } => {
	dir = mkdtempSync(join(tmpdir(), "lsp-fenced-"));
	mkdirSync(join(dir, "root"));
	writeFileSync(join(dir, "root/marker"), "");
	const file = join(dir, "root/one.ts");
	writeFileSync(file, "");
	const pool = createStandaloneBackend({
		servers: {
			fake: fake("fake"),
			...(also ? { [also]: fake(also) } : {}),
		},
	});
	backend = pool;
	return { file, pool };
};

it("stops one fence's servers when its conversation ends, and no other's", async () => {
	const { file, pool } = backendWithFile();
	await pool.diagnostics(file, { fence: fence("fence|one") });
	await pool.diagnostics(file, { fence: fence("fence|two") });
	await pool.diagnostics(file);

	pool.stopFence("fence|one");

	await vi.waitFor(() => expect(started[0]?.disposed).toHaveBeenCalledOnce());
	expect(started[1]?.disposed).not.toHaveBeenCalled();
	expect(started[2]?.disposed).not.toHaveBeenCalled();
	expect(pool.serverCount()).toBe(2);
});

it("stops a fence's server busy with a call as the call settles", async () => {
	const { file, pool } = backendWithFile();
	const one = fence("fence|one");
	await pool.diagnostics(file, { fence: one });
	let settle = () => {};
	const first = started[0];
	if (!first) throw new Error("no server started");
	first.hold.until = new Promise((done) => {
		settle = done;
	});
	const busy = pool.diagnostics(file, { fence: one });

	pool.stopFence("fence|one");
	// A stop that ignored the call would dispose a turn of the loop later.
	await new Promise((turn) => setImmediate(turn));
	expect(first.disposed).not.toHaveBeenCalled();
	settle();
	await busy;

	await vi.waitFor(() => expect(first.disposed).toHaveBeenCalledOnce());
	expect(pool.serverCount()).toBe(0);
});

it("stops a server a call starts in a fence after its conversation ended, as the call settles", async () => {
	const { file, pool } = backendWithFile("lint");
	let go = () => {};
	pending.next = new Promise<never>((done) => {
		go = done as () => void;
	});
	// The call waits on its first server's start, and starts its second
	// only once its conversation has ended.
	const call = pool.diagnostics(file, { fence: fence("fence|one") });
	await vi.waitFor(() => expect(pending.next).toBeUndefined());

	pool.stopFence("fence|one");
	go();
	await call;

	await vi.waitFor(() => expect(started[1]?.disposed).toHaveBeenCalledOnce());
	expect(started[0]?.disposed).toHaveBeenCalledOnce();
	expect(pool.serverCount()).toBe(0);
});

it("keeps the servers of a call begun after its conversation ended, as one that reloaded", async () => {
	const { file, pool } = backendWithFile();
	const one = fence("fence|one");
	await pool.diagnostics(file, { fence: one });
	pool.stopFence("fence|one");

	await pool.diagnostics(file, { fence: one });
	await new Promise((turn) => setImmediate(turn));

	expect(started[1]?.disposed).not.toHaveBeenCalled();
	expect(pool.serverCount()).toBe(1);
});

it("drops one fence's servers while its conversation goes on, and starts them afresh at its next call", async () => {
	const { file, pool } = backendWithFile();
	const one = fence("fence|one");
	await pool.diagnostics(file, { fence: one });
	await pool.diagnostics(file, { fence: fence("fence|two") });

	pool.dropFence("fence|one");
	await vi.waitFor(() => expect(started[0]?.disposed).toHaveBeenCalledOnce());
	await pool.diagnostics(file, { fence: one });
	await new Promise((turn) => setImmediate(turn));

	expect(started.map((each) => each.fence)).toEqual([
		"fence|one",
		"fence|two",
		"fence|one",
	]);
	expect(started[1]?.disposed).not.toHaveBeenCalled();
	expect(started[2]?.disposed).not.toHaveBeenCalled();
	expect(pool.serverCount()).toBe(2);
});

it("keeps the server that replaced a dropped one that died while busy, once every call settles", async () => {
	// The tool drops a fence's servers when one died under a call, and
	// asks once more; a call still in flight on the dead one then settles
	// after the replacement has started.
	const { file, pool } = backendWithFile();
	const one = fence("fence|one");
	await pool.diagnostics(file, { fence: one });
	const dead = started[0];
	if (!dead) throw new Error("no server started");
	let settle = () => {};
	dead.hold.until = new Promise((done) => {
		settle = done;
	});
	const busy = pool.diagnostics(file, { fence: one });
	await new Promise((turn) => setImmediate(turn));

	pool.dropFence("fence|one");
	dead.gone();
	await pool.diagnostics(file, { fence: one });
	settle();
	await busy;
	await new Promise((turn) => setImmediate(turn));

	expect(started).toHaveLength(2);
	expect(started[1]?.disposed).not.toHaveBeenCalled();
	expect(pool.serverCount()).toBe(1);
});

it("lets go at quit of a server whose start fails while it waits, rather than failing the quit", async () => {
	const { file, pool } = backendWithFile();
	let fail: (error: Error) => void = () => {};
	pending.next = new Promise<never>((_, reject) => {
		fail = reject;
	});
	const call = pool
		.diagnostics(file, { fence: fence("fence|one") })
		.catch((error: unknown) => error);
	await vi.waitFor(() => expect(pending.next).toBeUndefined());

	const quit = pool.dispose();
	backend = undefined;
	fail(new Error("fake couldn't run in the fence: refused"));

	await expect(quit).resolves.toBeUndefined();
	await call;
});

it("starts a server for each fence, and asks only the calling fence's in a search", async () => {
	const { file, pool: backend } = backendWithFile();
	const one = fence("fence|one");
	const two = fence("fence|two");

	await backend.diagnostics(file, { fence: one });
	await backend.diagnostics(file, { fence: one });
	await backend.diagnostics(file, { fence: two });
	await backend.diagnostics(file);

	expect(started.map((each) => each.fence)).toEqual([
		"fence|one",
		"fence|two",
		undefined,
	]);
	await backend.workspaceSymbols("thing", { fence: two });
	expect(started.map((each) => each.search.mock.calls.length)).toEqual([
		0, 1, 0,
	]);
	await backend.workspaceSymbols("thing");
	expect(started.map((each) => each.search.mock.calls.length)).toEqual([
		0, 1, 1,
	]);
});
