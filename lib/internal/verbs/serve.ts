/**
 * The verbs server: what the launcher keeps a connection open to, so it
 * lists the verbs ready and builds a verb's prompt without starting a
 * program for either. It speaks version 1 of the interface every daemon
 * the launcher reads speaks (core's docs/daemons.md), one JSON object a
 * line: `hello`, `get`, `list`, `watch` (by kind or keys), `unwatch` and
 * `health` as daemon-serve answers them, over one kind of record, `verb`,
 * keyed `verb:<id>`. A watch is answered `{id, records}` whole, then told
 * under its id only the records a verb file changed and the keys `gone`.
 * Two asks are its own:
 *
 * - `{id, ask: "verb", verb, args, selection}` answers `{id, ok, use,
 *   system, prompt}`, or for a verb that hands on, `{id, ok, use, text}`;
 *   the launcher's own warm pi asks the model. A selection or argument
 *   that looks like a secret is refused and never counted.
 * - `{id, ask: "told", use, outcome}` counts what became of a use.
 *
 * It captures nothing itself: it only sees what the launcher sends.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, type FSWatcher, mkdirSync, rmSync, watch } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { runtimeDir } from "../paths.ts";
import { isRecord } from "../record.ts";
import { type KnownSecret, knownSecrets, scrubSecrets } from "../secrets.ts";
import { OUTCOMES, recordUse, type UseOutcome } from "./uses.ts";
import { fillVerb, readVerbs, type Verb, verbRecord } from "./verb.ts";

/** What a refused secret is answered with, as the person reads it. */
export const SECRET_REFUSED = "this looks like a secret; not sent";

/** How long a folder is let settle after it moves before it's read again. */
const SETTLE_MS = 100;

/** The longest line a connection may send, a selection with room to spare. */
const MOST_LINE = 4 * 1024 * 1024;

/** What a verbs server is given. */
interface VerbServerOptions {
	/** The folders holding verbs, a later one's taking a name over an earlier's. */
	readonly folders: readonly string[];
	/** The file each use and what became of it is counted in. */
	readonly uses: string;
	/** The secrets the environment holds; the process's own unless given. */
	readonly known?: readonly KnownSecret[];
	readonly now?: () => Date;
	readonly settleMs?: number;
	/** Where what goes wrong is said; standard error unless given. */
	readonly log?: (line: string) => void;
}

/** A verbs server, not yet listening, and how to stop it. */
export interface VerbServer {
	readonly server: Server;
	stop(): Promise<void>;
}

/** The server's name as the interface says it, its socket's and its unit's. */
const DOMAIN = "pi-verbs";

/** The one kind of record it holds. */
const KIND = "verb";

/** One watch a connection holds, of every verb or of the keys it names. */
interface Watch {
	readonly socket: Socket;
	readonly id: unknown;
	readonly keys: ReadonlySet<string> | undefined;
}

/** The answer to one line, without the id it's answered under. */
type Answer = Record<string, unknown>;

/**
 * The socket the verbs server listens on, in the login's runtime folder
 * beside the launcher's other daemons; none where there is no such folder.
 */
export function verbsSocket(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const runtime = runtimeDir(env);
	return runtime ? join(runtime, "daemons", "pi-verbs.sock") : undefined;
}

/** The descriptor systemd hands a socket-activated service first. */
const FIRST_HANDED = 3;

/**
 * Listens on the socket systemd holds for the server when the program
 * says it was handed one (`handed`), so the launcher never finds it
 * missing while the server starts; or else on `socket`, in a folder only
 * the login reads, taking the place of one a stopped server left behind.
 */
export function listenForVerbs(
	server: Server,
	socket: string,
	handed: boolean,
): Promise<void> {
	return new Promise((done, fail) => {
		server.once("error", fail);
		if (handed) {
			server.listen({ fd: FIRST_HANDED }, () => done());
			return;
		}
		// A folder made here is made the login's alone, whatever the umask;
		// one already there, as the daemons' shared one, is left as it is.
		if (mkdirSync(dirname(socket), { recursive: true, mode: 0o700 })) {
			chmodSync(dirname(socket), 0o700);
		}
		rmSync(socket, { force: true });
		server.listen(socket, () => {
			chmodSync(socket, 0o600);
			done();
		});
	});
}

/** A verbs server over `options`' folders, reading them now. */
export function verbServer(options: VerbServerOptions): VerbServer {
	const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
	const now = options.now ?? (() => new Date());
	const known = options.known ?? knownSecrets();
	const sockets = new Set<Socket>();
	const watches: Watch[] = [];
	const verbsOfUses = new Map<string, string>();
	const since = now().getTime();
	let verbs = new Map<string, Verb>();
	let records = new Map<string, string>();

	function read(): void {
		const found = readVerbs(options.folders);
		for (const { file, problem } of found.problems) {
			log(`pi-verbs: ${file} is refused because ${problem}`);
		}
		verbs = found.verbs;
		const next = new Map<string, string>();
		for (const id of [...verbs.keys()].sort()) {
			const verb = verbs.get(id);
			if (verb) next.set(`verb:${id}`, JSON.stringify(verbRecord(verb)));
		}
		const changed = [...next].filter(
			([key, text]) => records.get(key) !== text,
		);
		const gone = [...records.keys()].filter((key) => !next.has(key));
		records = next;
		if (changed.length === 0 && gone.length === 0) return;
		for (const { socket, id, keys } of watches) {
			const theirs = changed.filter(([key]) => !keys || keys.has(key));
			const went = gone.filter((key) => !keys || keys.has(key));
			if (theirs.length === 0 && went.length === 0) continue;
			write(socket, {
				id,
				changed: theirs.map(([, text]) => JSON.parse(text)),
				...(went.length > 0 ? { gone: went } : {}),
			});
		}
	}

	/** The records held, of the keys named or of every verb. */
	function held(keys?: ReadonlySet<string>): unknown[] {
		return [...records]
			.filter(([key]) => !keys || keys.has(key))
			.map(([, text]) => JSON.parse(text));
	}

	function answer(line: Record<string, unknown>, socket: Socket): Answer {
		const ask = typeof line.ask === "string" ? line.ask : "";
		const stranger = strangeKind(line.kind);
		if ((ask === "watch" || ask === "list") && stranger !== undefined) {
			return failed("unknown-kind", `no kind ${stranger} here`);
		}
		switch (ask) {
			case "hello":
				return {
					version: 1,
					domain: DOMAIN,
					state: "answering",
					since,
					sources: {},
				};
			case "health":
				return {
					version: 1,
					domain: DOMAIN,
					state: "answering",
					since,
					sources: {},
					watches: watches.length,
					records: records.size,
				};
			case "get":
				return { records: held(keysOf(line.keys) ?? new Set()) };
			case "list":
				return { records: held() };
			case "watch": {
				const keys = keysOf(line.keys);
				unwatch(socket, line.id);
				watches.push({ socket, id: line.id, keys });
				return { records: held(keys) };
			}
			case "unwatch":
				unwatch(socket, line.id);
				return { unwatched: true };
			case "verb":
				return askVerb(line);
			case "told":
				return told(line);
			default:
				return failed("unknown-ask", `no ask ${JSON.stringify(ask)} here`);
		}
	}

	/** Ends the watches a connection holds under `id`, or all of them. */
	function unwatch(socket: Socket, id?: unknown): void {
		for (let at = watches.length - 1; at >= 0; at--) {
			const one = watches[at];
			if (one?.socket === socket && (id === undefined || one.id === id)) {
				watches.splice(at, 1);
			}
		}
	}

	function askVerb(line: Record<string, unknown>): Answer {
		const verb = verbs.get(String(line.verb));
		if (!verb)
			return {
				ok: false,
				refused: `there is no verb named ${String(line.verb)}`,
			};
		if (typeof line.selection !== "string") {
			return { ok: false, refused: "a verb is asked of a selection" };
		}
		const args = stringsOf(line.args);
		if (!args)
			return { ok: false, refused: "a verb's arguments are words by name" };
		const filled = fillVerb(verb, args, line.selection);
		if ("problem" in filled) return { ok: false, refused: filled.problem };
		const asked = [line.selection, ...Object.values(args)].join("\n");
		if (scrubSecrets(asked, known).kinds.length > 0) {
			return { ok: false, refused: SECRET_REFUSED };
		}
		const use = randomUUID();
		verbsOfUses.set(use, verb.id);
		count(use, verb.id, "asked");
		return verb.result === "hand"
			? { ok: true, use, text: filled.prompt }
			: { ok: true, use, system: verb.system, prompt: filled.prompt };
	}

	function told(line: Record<string, unknown>): Answer {
		const outcome = OUTCOMES.find((one) => one === line.outcome);
		if (!outcome) {
			return {
				ok: false,
				refused: `${String(line.outcome)} is not ${OUTCOMES.join(", ").replace(/, (?=[^,]*$)/, " or ")}`,
			};
		}
		if (typeof line.use !== "string")
			return { ok: false, refused: "told names no use" };
		count(line.use, verbsOfUses.get(line.use) ?? "", outcome);
		return { ok: true };
	}

	function count(use: string, verb: string, outcome: UseOutcome): void {
		try {
			recordUse(options.uses, { at: now().toISOString(), use, verb, outcome });
		} catch (error) {
			log(`pi-verbs: a use of ${verb} went uncounted: ${String(error)}`);
		}
	}

	function serve(socket: Socket): void {
		sockets.add(socket);
		let pending = "";
		socket.setEncoding("utf8");
		socket.on("data", (data: string) => {
			pending += data;
			let end = pending.indexOf("\n");
			while (end >= 0) {
				const text = pending.slice(0, end);
				pending = pending.slice(end + 1);
				if (text.trim()) one(text, socket);
				end = pending.indexOf("\n");
			}
			if (pending.length > MOST_LINE) {
				write(socket, {
					id: null,
					...failed("too-long", "that line is too long"),
				});
				socket.destroy();
			}
		});
		socket.on("error", () => socket.destroy());
		socket.on("close", () => {
			sockets.delete(socket);
			unwatch(socket);
		});
	}

	function one(text: string, socket: Socket): void {
		let line: unknown;
		try {
			line = JSON.parse(text);
		} catch {
			// The asker said something that isn't a line of the interface;
			// it hears so and the connection goes on.
			write(socket, {
				id: null,
				...failed("unknown-ask", "that line is not JSON"),
			});
			return;
		}
		if (!isRecord(line)) {
			write(socket, {
				id: null,
				...failed("unknown-ask", "that line is no object"),
			});
			return;
		}
		write(socket, { id: line.id, ...answer(line, socket) });
	}

	read();
	let settling: NodeJS.Timeout | undefined;
	const watchers: FSWatcher[] = [];
	for (const folder of options.folders) {
		try {
			watchers.push(
				watch(folder, () => {
					clearTimeout(settling);
					settling = setTimeout(read, options.settleMs ?? SETTLE_MS);
				}),
			);
		} catch {
			// A folder that isn't there holds no verbs; one made later is
			// read when the server starts again.
		}
	}

	const server = createServer(serve);
	return {
		server,
		stop: () =>
			new Promise<void>((done) => {
				clearTimeout(settling);
				for (const watcher of watchers) watcher.close();
				for (const socket of sockets) socket.destroy();
				if (!server.listening) {
					done();
					return;
				}
				server.close(() => done());
			}),
	};
}

/** An answer refusing an ask, by the interface's codes. */
function failed(code: string, message: string): Answer {
	return { error: { code, message } };
}

/** The first kind an ask names that isn't a verb, or none. */
function strangeKind(kind: unknown): string | undefined {
	if (kind === undefined || kind === null) return undefined;
	const named = Array.isArray(kind) ? kind : [kind];
	const stranger = named.find((one) => one !== KIND);
	return stranger === undefined ? undefined : String(stranger);
}

/** The keys an ask names, or none when it names none. */
function keysOf(keys: unknown): Set<string> | undefined {
	if (!Array.isArray(keys)) return undefined;
	return new Set(keys.filter((key): key is string => typeof key === "string"));
}

/** Words by name, as a verb's arguments are given; none given is none. */
function stringsOf(raw: unknown): Record<string, string> | undefined {
	if (raw === undefined || raw === null) return {};
	if (!isRecord(raw)) return undefined;
	const strings: Record<string, string> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (typeof value !== "string") return undefined;
		strings[name] = value;
	}
	return strings;
}

/** Writes one line to a connection still open. */
function write(socket: Socket, line: Answer): void {
	if (!socket.destroyed) socket.write(`${JSON.stringify(line)}\n`);
}
