/**
 * Spike (worker per awake engine), never merged: calls and one-way words
 * between the host's main thread and a conversation's worker over one
 * MessagePort. A call answers its value or rejects with the other side's
 * error, message and stack kept; a word has no answer. Both sides see
 * messages in the order they were sent, which the worker engine relies on:
 * what a worker says of a conversation before it answers a call reaches
 * the main thread first.
 */

/** The port either side talks over: a Worker on the main thread, parentPort in the worker. */
export interface Port {
	postMessage(value: unknown): void;
	on(event: "message", listener: (value: unknown) => void): unknown;
}

/** What one side answers the other's calls and words with. */
export type Handlers = Readonly<
	Record<string, (...args: readonly unknown[]) => unknown>
>;

/** One side of the channel. */
export interface Channel {
	call(method: string, ...args: readonly unknown[]): Promise<unknown>;
	tell(word: string, ...args: readonly unknown[]): void;
	/** Reject every call still waiting, as when the other side is gone. */
	fail(error: Error): void;
}

interface Waiting {
	resolve(value: unknown): void;
	reject(error: unknown): void;
}

/** Open a channel over `port`, answering with `handlers`. */
export function openChannel(
	port: Port,
	handlers: Handlers,
	report: (error: unknown) => void,
): Channel {
	let next = 0;
	const waiting = new Map<number, Waiting>();
	port.on("message", (value) => {
		if (typeof value !== "object" || value === null) return;
		const kind: unknown = Reflect.get(value, "kind");
		if (kind === "reply") {
			const id = Number(Reflect.get(value, "id"));
			const one = waiting.get(id);
			if (!one) return;
			waiting.delete(id);
			if (Reflect.get(value, "ok") === true)
				one.resolve(Reflect.get(value, "value"));
			else one.reject(revived(Reflect.get(value, "error")));
			return;
		}
		const name = String(Reflect.get(value, "name"));
		const raw: unknown = Reflect.get(value, "args");
		const args: readonly unknown[] = Array.isArray(raw) ? raw : [];
		const handler = handlers[name];
		if (kind === "tell") {
			if (!handler) {
				report(new Error(`No handler for word ${name}`));
				return;
			}
			try {
				const said = handler(...args);
				if (said instanceof Promise) said.catch(report);
			} catch (error) {
				report(error);
			}
			return;
		}
		if (kind !== "call") return;
		const id = Reflect.get(value, "id");
		Promise.resolve()
			.then(() => {
				if (!handler) throw new Error(`No handler for call ${name}`);
				return handler(...args);
			})
			.then(
				(answer) => port.postMessage({ kind: "reply", id, ok: true, value: answer }),
				(error: unknown) =>
					port.postMessage({ kind: "reply", id, ok: false, error: flat(error) }),
			)
			.catch(report);
	});
	return {
		call(method, ...args) {
			const id = next++;
			return new Promise((resolve, reject) => {
				waiting.set(id, { resolve, reject });
				port.postMessage({ kind: "call", id, name: method, args });
			});
		},
		tell(word, ...args) {
			port.postMessage({ kind: "tell", name: word, args });
		},
		fail(error) {
			for (const one of waiting.values()) one.reject(error);
			waiting.clear();
		},
	};
}

/** An error as it crosses: its message and stack. */
export function flat(error: unknown): { message: string; stack?: string } {
	if (error instanceof Error)
		return {
			message: error.message,
			...(error.stack ? { stack: error.stack } : {}),
		};
	return { message: String(error) };
}

/** An error that crossed, made an Error again. */
export function revived(said: unknown): Error {
	const message =
		typeof said === "object" && said !== null
			? String(Reflect.get(said, "message"))
			: String(said);
	const error = new Error(message);
	const stack =
		typeof said === "object" && said !== null
			? Reflect.get(said, "stack")
			: undefined;
	if (typeof stack === "string") error.stack = stack;
	return error;
}
