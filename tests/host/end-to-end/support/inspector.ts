/**
 * A host process's own inspector, for a case about what the host keeps
 * in memory: the host started with `--inspect=127.0.0.1:0` says where it
 * listens on stderr, and this speaks the DevTools protocol to it over a
 * WebSocket, to collect garbage and read the heap's use as V8 counts it.
 *
 * Only a sealed host a case started is ever inspected, never a live one.
 */

import { until } from "../../../support/until.ts";

/** What a host started with an inspector says on stderr, naming where. */
const LISTENING = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[\w-]+)/;

/** How long a host's inspector may take to say where it listens. */
const LISTEN_WAIT_MS = 30_000;

/** How long one request to the inspector may take, a forced collection included. */
const REQUEST_WAIT_MS = 120_000;

/** The node flag that starts a host's inspector on a free local port. */
export const INSPECT_LOCALLY = "--inspect=127.0.0.1:0";

/** A host's inspector, as a case asks it. */
export interface Inspector {
	/** Send one DevTools request, answering its result. */
	send(method: string, params?: Record<string, unknown>): Promise<unknown>;
	/** The heap's used bytes once V8 has collected all it can. */
	heapAfterCollect(): Promise<number>;
	/** The value of an expression evaluated in the host. */
	evaluate(expression: string): Promise<unknown>;
	/** How many timers still set in the host call a function of this name. */
	timersCalling(name: string): Promise<number>;
	/** A heap snapshot of the host, as the JSON V8 writes. */
	snapshot(): Promise<string>;
	/** Let the inspector go. */
	close(): void;
}

/** Connect to the inspector of the host whose stderr `said` answers. */
export async function inspect(said: () => string): Promise<Inspector> {
	let address = "";
	await until(
		"the host's inspector says where it listens",
		async () => {
			address = LISTENING.exec(said())?.[1] ?? "";
			return address !== "";
		},
		LISTEN_WAIT_MS,
	);
	const socket = new WebSocket(address);
	await new Promise<void>((done, fail) => {
		socket.addEventListener("open", () => done(), { once: true });
		socket.addEventListener(
			"error",
			() => fail(new Error(`couldn't reach the inspector at ${address}`)),
			{ once: true },
		);
	});
	const waiting = new Map<
		number,
		{ done: (result: unknown) => void; fail: (error: Error) => void }
	>();
	let chunks: string[] | undefined;
	socket.addEventListener("message", (event) => {
		const message: unknown = JSON.parse(String(event.data));
		if (typeof message !== "object" || message === null) return;
		if (
			Reflect.get(message, "method") === "HeapProfiler.addHeapSnapshotChunk"
		) {
			const params: unknown = Reflect.get(message, "params");
			const chunk: unknown =
				typeof params === "object" && params !== null
					? Reflect.get(params, "chunk")
					: undefined;
			if (typeof chunk === "string") chunks?.push(chunk);
			return;
		}
		const id: unknown = Reflect.get(message, "id");
		if (typeof id !== "number") return;
		const asked = waiting.get(id);
		if (asked === undefined) return;
		waiting.delete(id);
		const error: unknown = Reflect.get(message, "error");
		if (error !== undefined) asked.fail(new Error(JSON.stringify(error)));
		else asked.done(Reflect.get(message, "result"));
	});
	let sent = 0;
	const send = (method: string, params: Record<string, unknown> = {}) =>
		new Promise<unknown>((done, fail) => {
			const id = ++sent;
			const timer = setTimeout(() => {
				waiting.delete(id);
				fail(new Error(`the inspector didn't answer ${method}`));
			}, REQUEST_WAIT_MS);
			waiting.set(id, {
				done: (result) => {
					clearTimeout(timer);
					done(result);
				},
				fail: (error) => {
					clearTimeout(timer);
					fail(error);
				},
			});
			socket.send(JSON.stringify({ id, method, params }));
		});
	const field = (from: unknown, name: string): unknown =>
		typeof from === "object" && from !== null
			? Reflect.get(from, name)
			: undefined;
	const answered = (answer: unknown): unknown =>
		field(field(answer, "result"), "value");
	return {
		send,
		evaluate: async (expression) =>
			answered(
				await send("Runtime.evaluate", { expression, returnByValue: true }),
			),
		timersCalling: async (name) => {
			// Every Timeout the heap holds, by their prototype, then those set
			// and calling `name`; a cleared one is marked destroyed.
			const prototype = field(
				field(
					await send("Runtime.evaluate", {
						expression:
							"(() => { const t = setTimeout(() => {}, 1); clearTimeout(t); return Object.getPrototypeOf(t); })()",
					}),
					"result",
				),
				"objectId",
			);
			const timers = field(
				field(
					await send("Runtime.queryObjects", { prototypeObjectId: prototype }),
					"objects",
				),
				"objectId",
			);
			const count = answered(
				await send("Runtime.callFunctionOn", {
					objectId: timers,
					functionDeclaration:
						"function (name) { return this.filter((t) => !t._destroyed && typeof t._onTimeout === 'function' && t._onTimeout.name === name).length; }",
					arguments: [{ value: name }],
					returnByValue: true,
				}),
			);
			if (typeof count !== "number") {
				throw new Error(`the inspector counted no timers calling ${name}`);
			}
			return count;
		},
		heapAfterCollect: async () => {
			// Twice, since what one collection finalizes may free more in the next.
			await send("HeapProfiler.collectGarbage");
			await send("HeapProfiler.collectGarbage");
			const usage = await send("Runtime.getHeapUsage");
			const used: unknown =
				typeof usage === "object" && usage !== null
					? Reflect.get(usage, "usedSize")
					: undefined;
			if (typeof used !== "number") {
				throw new Error(`the inspector read no heap: ${JSON.stringify(usage)}`);
			}
			return used;
		},
		snapshot: async () => {
			chunks = [];
			await send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
			const json = chunks.join("");
			chunks = undefined;
			return json;
		},
		close: () => socket.close(),
	};
}
