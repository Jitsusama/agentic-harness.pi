import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createStandaloneBackend,
	type LspCallOptions,
	type StandaloneBackend,
} from "../../../../lib/core/lsp/index.ts";

const fixture = fileURLToPath(
	new URL("./fixtures/silent-server.mjs", import.meta.url),
);

/** Longer than any bounded call here should take to end. */
const STILL_RUNNING_MS = 5000;
/** How long a cancellation may take to reach the server. */
const CANCEL_ARRIVES_MS = 3000;
/**
 * How long the server may take to start and get a request. Giving up a
 * fixed second in left nothing to cancel when a loaded machine (load 65)
 * took longer than that to start it.
 */
const REQUEST_ARRIVES_MS = 20_000;

/** The call's outcome, or a note that it was still waiting. */
async function outcome(call: Promise<unknown>): Promise<string> {
	const running = new Promise<string>((resolve) =>
		setTimeout(() => resolve("still running"), STILL_RUNNING_MS),
	);
	return Promise.race([
		call.then(
			() => "answered",
			(error: unknown) =>
				error instanceof Error ? error.name : `threw ${String(error)}`,
		),
		running,
	]);
}

/** Waits until the server has a request for `method`. */
async function arrived(received: string, method: string): Promise<void> {
	const seen = await logged(received, method, REQUEST_ARRIVES_MS);
	if (!seen.includes(method)) {
		throw new Error(`The server never got ${method}.`);
	}
}

/** The methods the server was told to stop working on, once it has been. */
async function cancelled(log: string, method: string): Promise<string[]> {
	return logged(log, method, CANCEL_ARRIVES_MS);
}

/** The methods in a log the server writes, once `method` is, or by `withinMs`. */
async function logged(
	log: string,
	method: string,
	withinMs: number,
): Promise<string[]> {
	const deadline = Date.now() + withinMs;
	for (;;) {
		const seen = existsSync(log)
			? readFileSync(log, "utf8").split("\n").filter(Boolean)
			: [];
		if (seen.includes(method) || Date.now() > deadline) return seen;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

type Operation = (
	backend: StandaloneBackend,
	file: string,
	options: LspCallOptions,
) => Promise<unknown>;

const at = (path: string) => ({ path, position: { line: 1, character: 0 } });

/** Each operation that waits on the server, with the method it sends. */
const OPERATIONS: ReadonlyArray<[string, string, Operation]> = [
	[
		"definition",
		"textDocument/definition",
		(b, f, o) => b.definition(at(f), o),
	],
	[
		"references",
		"textDocument/references",
		(b, f, o) => b.references(at(f), o),
	],
	["hover", "textDocument/hover", (b, f, o) => b.hover(at(f), o)],
	[
		"documentSymbols",
		"textDocument/documentSymbol",
		(b, f, o) => b.documentSymbols(f, o),
	],
	["rename", "textDocument/rename", (b, f, o) => b.rename(at(f), "renamed", o)],
	[
		"codeActions",
		"textDocument/codeAction",
		(b, f, o) => b.codeActions(f, undefined, o),
	],
];

describe("a standalone request the server never answers", () => {
	let dir: string;
	let file: string;
	let log: string;
	let received: string;
	let backend: StandaloneBackend | undefined;

	const start = (requestMs?: number): StandaloneBackend => {
		backend = createStandaloneBackend({
			servers: {
				silent: {
					name: "silent",
					command: process.execPath,
					args: [fixture, log, received],
					fileTypes: [".silent"],
					rootMarkers: ["root.marker"],
				},
			},
			...(requestMs === undefined ? {} : { requestMs }),
		});
		return backend;
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lsp-silent-"));
		writeFileSync(join(dir, "root.marker"), "");
		file = join(dir, "one.silent");
		writeFileSync(file, "nothing here\n");
		log = join(dir, "cancelled.log");
		received = join(dir, "received.log");
	});

	afterEach(async () => {
		await backend?.dispose();
		backend = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	for (const [name, method, operation] of OPERATIONS) {
		it(`ends a ${name} the moment its caller gives up, and tells the server`, async () => {
			const controller = new AbortController();
			const call = operation(start(), file, { signal: controller.signal });
			await arrived(received, method);
			controller.abort();
			expect(await outcome(call)).toBe("AbortError");
			expect(await cancelled(log, method)).toContain(method);
		}, 30_000);
	}

	it("ends a workspace symbol search the moment its caller gives up", async () => {
		const live = start();
		// Workspace symbols only search a server already running, so
		// start one with a call that is let go of straight away.
		const warm = new AbortController();
		const warming = live.documentSymbols(file, { signal: warm.signal });
		await arrived(received, "textDocument/documentSymbol");
		warm.abort();
		await outcome(warming);
		const controller = new AbortController();
		const call = live.workspaceSymbols("anything", {
			signal: controller.signal,
		});
		await arrived(received, "workspace/symbol");
		controller.abort();
		expect(await outcome(call)).toBe("AbortError");
		expect(await cancelled(log, "workspace/symbol")).toContain(
			"workspace/symbol",
		);
	}, 45_000);

	it("gives up on a request that outlasts the request clock, and says so", async () => {
		const call = start(1500).definition(at(file));
		expect(await outcome(call)).toBe("TimeoutError");
		expect(await cancelled(log, "textDocument/definition")).toContain(
			"textDocument/definition",
		);
	}, 15_000);

	it("still answers what the server does answer", async () => {
		// Diagnostics come from what the server published, which this one
		// does at once; a clock on every request must not cost that. The
		// clock is roomy, since at a load of 65 the server took longer than
		// 1.5 s to start and publish, and the wait is all this test reads.
		const call = start(REQUEST_ARRIVES_MS).diagnostics(file);
		expect(
			await Promise.race([
				call.then(
					() => "answered",
					(error: unknown) =>
						error instanceof Error ? error.name : String(error),
				),
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("still running"), REQUEST_ARRIVES_MS),
				),
			]),
		).toBe("answered");
	}, 30_000);
});
