/** Private Unix listener and bounded viewer transport; session work stays in the engine. */
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net";
import { dirname, isAbsolute } from "node:path";
import { withSession } from "../../lib/core/session/index.ts";
import { sessionAddress } from "../../lib/mesh/address.ts";
import { ATTACH_SLOW_MS, secondsSince } from "./attach-waits.ts";
import {
	askOnce,
	childUnreachable,
	fromChild,
	MAX_ANSWER_BYTES,
	reach,
} from "./child-requests.ts";
import {
	type ChildRoute,
	type ChildRoutes,
	listingChildren,
	passedOn,
} from "./children.ts";
import {
	type ControlBackend,
	dispatchControl,
	failedReply,
	sameHost,
	staleHost,
} from "./dispatch.ts";
import { jsonLines } from "./framing.ts";
import {
	type ControlRequest,
	DIRECT_ATTACH,
	parseControl,
	parseViewer,
} from "./protocol.ts";

const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const SOCKET_MODE = 0o600;
/**
 * How long a restarting host waits for its viewers to take the frame
 * saying so before it closes on them, well inside the 30 s a client
 * holds keys for after it.
 */
const RESTART_FLUSH_MS = 2_000;
const DIRECTORY_MODE = 0o700;

/** One viewer's connection to a persistent Terminal, not the session itself. */
export interface ViewerConnection {
	input(data: string): void;
	resize(rows: number, columns: number): void;
	/** The client's answer to an edit it was sent; one it wasn't is dropped. */
	edited?(id: string, text?: string): void;
	/** The client says why it is about to go: its window was closed. */
	leave?(why: "closed"): void;
	detach(): void;
}

/** What the host sends one attached viewer, framed. */
export interface ViewerSink {
	write(data: string): void;
	disconnect(reason: string): void;
	/** Ask a client that said it can edit to edit `text` in its own terminal. */
	edit(id: string, text: string): void;
	/** Tell a client that said it can suspend to stop itself, and let it go. */
	suspend(): void;
}

/** V supplies a Terminal attachment; H2 supplies framed output and EOF handling. */
export interface ViewerBridge {
	attach(
		request: Extract<ControlRequest, { op: "attach" }>,
		sink: ViewerSink,
	): ViewerConnection;
}

/** A window's attach passed on to the child running its conversation. */
interface PassedOn {
	child: Socket;
	/** The attach, as the child takes it. */
	line: string;
	/** The attach's id, which the child's answer names. */
	id: string;
	sessionId: string;
}

/**
 * What a watch on a child host follows (child.ts): its answer, once the
 * child holds its conversation, and each line after it. An answer that
 * rejects with a refusal (dispatch.ts's hostRefusal) is said as one.
 */
export interface WatchBridge {
	answer(): Promise<unknown>;
	/** Hear each line from now on, until the returned call. */
	follow(send: (line: unknown) => void): () => void;
}

async function privateDirectory(path: string) {
	await mkdir(path, { mode: DIRECTORY_MODE, recursive: true });
	const info = await lstat(path);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		info.uid !== process.getuid?.() ||
		(info.mode & 0o777) !== DIRECTORY_MODE
	)
		throw new Error(
			"Host socket directory must be owned by this user with mode 0700",
		);
}

/**
 * End a connection once what was written to it has gone, or after
 * RESTART_FLUSH_MS, whichever comes first.
 */
function endWhenWritten(socket: Socket): Promise<void> {
	if (socket.destroyed) return Promise.resolve();
	return new Promise<void>((resolve) => {
		// A watcher that reads nothing never holds a close up for long.
		const timer = setTimeout(resolve, RESTART_FLUSH_MS);
		socket.end(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}

function errorCode(error: unknown): unknown {
	return error instanceof Error && "code" in error ? error.code : undefined;
}

function bind(server: Server, path: string) {
	return new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

/**
 * Whether the path is this user's socket with nothing answering it: what a
 * host killed with SIGKILL, or lost with the machine, leaves behind. A live
 * socket, another user's, or anything that is not a socket is never stale.
 */
async function abandoned(path: string): Promise<boolean> {
	const info = await lstat(path);
	if (!info.isSocket() || info.uid !== process.getuid?.()) return false;
	return new Promise((resolve) => {
		const probe = createConnection(path);
		probe.once("connect", () => {
			probe.destroy();
			resolve(false);
		});
		probe.once("error", (error) => {
			resolve(errorCode(error) === "ECONNREFUSED");
		});
	});
}

/**
 * Listen, taking over only a socket nothing answers. The caller must hold
 * the key's roster lock first, so no other host can bind between the probe
 * and the unlink. Stop detaches viewers, not sessions.
 */
export async function listenControl(options: {
	path: string;
	backend: ControlBackend;
	viewer?: ViewerBridge;
	report(error: unknown): void;
	/**
	 * Writes a line to the host's journal for an attached window sent
	 * nothing to draw in time: then, its first frame and size when it
	 * comes, or its leaving with nothing drawn. It also says a slow
	 * attach answered after its window had left.
	 */
	say?: (line: string) => void;
	/** How long an attached window may go undrawn before the journal says so: ATTACH_SLOW_MS. */
	attachSlowMs?: number;
	/**
	 * The conversations children run: a request naming one is passed on
	 * to its child's socket, and a window attaching to one is handed to
	 * the child whole, so the child answers on a thread of its own. A
	 * list names them with the host's own.
	 */
	children?: ChildRoutes;
	/** What a watch follows; without one, a watch is refused. */
	watch?: WatchBridge;
}) {
	if (!isAbsolute(options.path))
		throw new Error("Host socket path must be absolute");
	await privateDirectory(dirname(options.path));
	// A list names every conversation, whichever thread runs it.
	const backend = options.children
		? listingChildren(options.backend, options.children)
		: options.backend;
	const sockets = new Set<Socket>();
	// How to reach each connection a viewer is attached on.
	const viewing = new Map<Socket, (value: unknown) => void>();
	// How to end each connection passed on to a child, at a frame's edge.
	const passing = new Map<Socket, () => void>();
	// Each connection a watch follows, which a close ends only once what
	// was written to it, such as a child's ending line, has gone.
	const watching = new Set<Socket>();
	// Each connection with a request being answered, and when its answer
	// has been sent: a close lets it go first, since a child's close of its
	// conversation ends the child before it is answered.
	const answering = new Map<Socket, Promise<void>>();
	let ready = false;
	const server = createServer((socket) => {
		if (!ready) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		const frames = jsonLines();
		let viewer: ViewerConnection | undefined;
		let sessionId: string | undefined;
		let ended = false;
		// Once a watch is asked, what ends it; the connection then takes
		// nothing more from its other end.
		let unwatch: (() => void) | undefined;
		// Once a window is told a child's socket to join, whatever it sent
		// after its attach was meant for the child, so none of it is read.
		let redirected = false;
		// Until the window's first frame goes, what it does: nothing, unless
		// the line saying it was sent nothing in time has gone, when the
		// frame is journaled too, as is a leaving with nothing drawn.
		let firstFrame: ((bytes: number) => void) | undefined;
		let leftUndrawn: (() => void) | undefined;
		let undrawn: NodeJS.Timeout | undefined;
		function watchFirstFrame(id: string) {
			const answered = Date.now();
			const who = `${sessionAddress(id)} (${id})`;
			const since = () => secondsSince(answered);
			let late = false;
			undrawn = setTimeout(() => {
				late = true;
				options.say?.(
					`${who}: a window attached ${since()} s ago has been sent nothing to draw`,
				);
			}, options.attachSlowMs ?? ATTACH_SLOW_MS);
			// A host stopping never waits on a window's journal line.
			undrawn.unref();
			firstFrame = (bytes) => {
				firstFrame = undefined;
				leftUndrawn = undefined;
				clearTimeout(undrawn);
				if (late)
					options.say?.(
						`${who}: a window's first frame, ${bytes} bytes, was queued ${since()} s after its attach was answered`,
					);
			};
			leftUndrawn = () => {
				if (late)
					options.say?.(
						`${who}: a window attached ${since()} s ago left with nothing drawn`,
					);
			};
		}
		function detach() {
			if (ended) return;
			ended = true;
			clearTimeout(undrawn);
			firstFrame = undefined;
			leftUndrawn?.();
			leftUndrawn = undefined;
			if (viewer && sessionId) {
				const attached = viewer;
				try {
					withSession(sessionId, () => attached.detach());
				} catch (error) {
					options.report(error);
				}
			}
			unwatch?.();
			viewing.delete(socket);
			passing.delete(socket);
			watching.delete(socket);
			sockets.delete(socket);
		}
		/**
		 * Follow the child's conversation on this connection: every line
		 * from the ask on, held until the answer has gone ahead of them. A
		 * child that ends before answering refuses the watch, then sends the
		 * ending it held, so its why arrives as a line and never only in the
		 * refusal's words, and ends the connection, which takes nothing more.
		 */
		async function watch(request: ControlRequest, bridge: WatchBridge) {
			let held: unknown[] | undefined = [];
			unwatch = bridge.follow((line) => {
				if (held) held.push(line);
				else frame(line);
			});
			watching.add(socket);
			try {
				const result = await bridge.answer();
				frame({ v: 1, id: request.id, ok: true, result: result ?? null });
			} catch (error) {
				unwatch();
				frame(failedReply(request.id, error, options.report));
				for (const line of held ?? []) frame(line);
				socket.end();
				return;
			}
			const lines = held;
			held = undefined;
			for (const line of lines) frame(line);
		}
		// What the screen drew this tick, sent as one frame once the tick
		// ends: a redraw is dozens of small writes, and framing each alone
		// holds the loop every conversation in the host shares.
		let drawn = "";
		function output(data: string) {
			if (socket.destroyed || data === "") return;
			if (drawn === "") setImmediate(flush);
			drawn += data;
			// A UTF-16 unit is at least a byte, so this never under-counts.
			if (socket.writableLength + drawn.length > MAX_QUEUED_BYTES) {
				drawn = "";
				socket.destroy();
			}
		}
		function flush() {
			if (drawn === "") return;
			const data = drawn;
			drawn = "";
			frame({ type: "output", data });
			if (!socket.destroyed) firstFrame?.(Buffer.byteLength(data));
		}
		/** Send a frame after whatever the screen drew before it. */
		function send(value: unknown) {
			flush();
			frame(value);
		}
		function frame(value: unknown) {
			if (socket.destroyed) return;
			const line = `${JSON.stringify(value)}\n`;
			if (socket.writableLength + Buffer.byteLength(line) > MAX_QUEUED_BYTES) {
				socket.destroy();
				return;
			}
			socket.write(line);
		}
		/**
		 * Hand a window's connection to the child: the child's answer to the
		 * attach is read, as a caller is told it, and from then on what the
		 * window sends goes to the child as bytes, and what the child draws
		 * comes back as bytes, so neither is decoded on this thread again.
		 */
		function passOn(
			{ child, line, id, sessionId: passedId }: PassedOn,
			after: readonly unknown[],
			rest: Buffer,
		) {
			socket.off("data", received);
			const open = () => !socket.destroyed && !socket.writableEnded;
			// The answer to the attach, until its line ends; then null.
			let answer: Buffer | null = Buffer.alloc(0);
			// Whether the last byte sent ended a frame, so another may follow.
			let atEdge = false;
			let leaving = false;
			const leave = () => {
				if (open()) {
					socket.write(`${JSON.stringify({ type: "restarting" })}\n`);
					socket.end();
				}
				child.destroy();
			};
			// Before the child answers, the answer comes first and then this.
			passing.set(socket, () => {
				leaving = true;
				if (atEdge) leave();
			});
			const toWindow = (chunk: Buffer) => {
				if (!open() || chunk.length === 0) return;
				if (leaving) {
					// The rest of the frame the window was being sent, then the one
					// saying the host restarts.
					const lf = chunk.indexOf(10);
					if (lf === -1) socket.write(chunk);
					else {
						socket.write(chunk.subarray(0, lf + 1));
						leave();
					}
					return;
				}
				atEdge = chunk.at(-1) === 10;
				if (!socket.write(chunk)) child.pause();
			};
			child.on("data", (chunk: Buffer) => {
				if (answer === null) return toWindow(chunk);
				answer = Buffer.concat([answer, chunk]);
				const lf = answer.indexOf(10);
				if (lf === -1) {
					if (answer.length > MAX_ANSWER_BYTES) {
						answer = null;
						refuse(childUnreachable(id));
					}
					return;
				}
				const reply = fromChild(answer.subarray(0, lf), id);
				const drawn = answer.subarray(lf + 1);
				answer = null;
				if (!reply.ok) return refuse(reply);
				frame(reply);
				atEdge = true;
				if (leaving) return leave();
				toWindow(drawn);
			});
			/** Tell the window why it has no conversation, and leave the child. */
			function refuse(reply: unknown) {
				passing.delete(socket);
				frame(reply);
				if (open()) socket.end();
				child.destroy();
			}
			socket.on("drain", () => child.resume());
			child.on("close", () => {
				if (answer !== null) return refuse(childUnreachable(id));
				if (!open() || leaving) return;
				// A window cut off mid-frame can't be told why; one at a frame's
				// edge is, rather than left reading a bare end.
				if (atEdge) {
					frame({
						type: "detached",
						reason: "the process running this conversation ended",
					});
				}
				options.say?.(
					`${sessionAddress(passedId)} (${passedId}): the process running it ended under an attached window`,
				);
				socket.end();
			});
			// Its close follows, and tells the window.
			child.on("error", options.report);
			socket.on("close", () => child.destroy());
			child.write(line);
			for (const value of after) child.write(`${JSON.stringify(value)}\n`);
			if (rest.length) child.write(rest);
			socket.pipe(child);
		}
		/**
		 * Ask the child at `route` what `request` asks, under the child's own
		 * name: an attach hands the window over, anything else has one answer.
		 */
		async function routed(
			request: ControlRequest,
			route: ChildRoute,
		): Promise<PassedOn | undefined> {
			// The caller named this host, or the child, as the machine's host
			// registry and so a mesh presence name a child's conversation; this
			// host checks either against the whole process identity.
			if (
				request.expectedHost &&
				!sameHost(request.expectedHost, backend.identity) &&
				!sameHost(request.expectedHost, route.identity)
			) {
				send(staleHost(request.id));
				return;
			}
			let child: Socket;
			try {
				child = await reach(route.socket);
			} catch (error) {
				options.report(error);
				send(childUnreachable(request.id));
				return;
			}
			if (socket.destroyed || ended) {
				child.destroy();
				return;
			}
			// One that joins children itself is told the socket that just took
			// a connection, and its connection is done with.
			if (
				request.op === "attach" &&
				request.features?.includes(DIRECT_ATTACH)
			) {
				child.destroy();
				redirected = true;
				send({
					v: 1,
					id: request.id,
					ok: true,
					result: { sessionId: request.sessionId, socket: route.socket },
				});
				socket.end();
				return;
			}
			const line = `${JSON.stringify(passedOn(request, route))}\n`;
			if (request.op === "attach")
				return {
					child,
					line,
					id: request.id,
					sessionId: request.sessionId,
				};
			// Any other request has one answer, and the connection is the
			// host's again once it comes, for whatever is asked next.
			const gone = () => child.destroy();
			socket.once("close", gone);
			send(await askOnce(child, line, request.id, options.report));
			socket.off("close", gone);
			return undefined;
		}
		async function receive(value: unknown): Promise<PassedOn | undefined> {
			if (unwatch) return undefined;
			if (viewer && sessionId) {
				const input = parseViewer(value);
				const attached = viewer;
				withSession(sessionId, () => {
					if (input.type === "input") attached.input(input.data);
					else if (input.type === "resize")
						attached.resize(input.rows, input.columns);
					else if (input.type === "edited")
						attached.edited?.(input.id, input.text);
					else attached.leave?.(input.why);
				});
				return;
			}
			let request: ControlRequest;
			try {
				request = parseControl(value);
			} catch {
				send(await dispatchControl(value, backend, options.report));
				return;
			}
			if (
				// A drain parks a whole host's conversations, so it names the host too.
				["close", "release", "abort", "drain"].includes(request.op) &&
				!request.expectedHost
			) {
				send({
					v: 1,
					id: request.id,
					ok: false,
					error: {
						code: "missing_host_identity",
						message:
							"Session-ending requests require expectedHost discovery identity",
					},
				});
				return;
			}
			const route =
				"sessionId" in request
					? options.children?.routeOf(request.sessionId)
					: undefined;
			if (route) return routed(request, route);
			if (request.op === "watch" && options.watch) {
				await watch(request, options.watch);
				return;
			}
			if (request.op === "attach" && !options.viewer) {
				send({
					v: 1,
					id: request.id,
					ok: false,
					error: {
						code: "unsupported",
						message: "This host has no viewer bridge",
					},
				});
				return;
			}
			const asked = Date.now();
			let answered = (): void => undefined;
			answering.set(
				socket,
				new Promise<void>((resolve) => {
					answered = resolve;
				}),
			);
			let reply: Awaited<ReturnType<typeof dispatchControl>>;
			try {
				reply = await dispatchControl(request, backend, options.report);
				// An attach whose wake started its conversation in a child is the
				// child's to answer and draw, not this host's viewer.
				const woke =
					reply.ok && request.op === "attach"
						? options.children?.routeOf(request.sessionId)
						: undefined;
				if (woke) return routed(request, woke);
				send(reply);
			} finally {
				answering.delete(socket);
				answered();
			}
			const gone = socket.destroyed || ended;
			const slow =
				Date.now() - asked >= (options.attachSlowMs ?? ATTACH_SLOW_MS);
			if (reply.ok && request.op === "attach" && gone && slow)
				// Otherwise the backend's answered line would read as a window shown.
				options.say?.(
					`${sessionAddress(request.sessionId)} (${request.sessionId}): a window's attach was answered ${secondsSince(asked)} s after it was asked, once the window had left`,
				);
			if (reply.ok && request.op === "attach" && options.viewer && !gone) {
				sessionId = request.sessionId;
				watchFirstFrame(sessionId);
				viewer = withSession(sessionId, () =>
					options.viewer?.attach(request, {
						write: output,
						disconnect: (reason) => {
							send({ type: "detached", reason });
							socket.end();
						},
						edit: (id, text) => send({ type: "edit", id, text }),
						// The client stops itself and attaches again once it resumes.
						suspend: () => {
							send({ type: "suspend" });
							socket.end();
						},
					}),
				);
				viewing.set(socket, send);
			}
			return undefined;
		}
		let passed = false;
		function received(chunk: Buffer | string) {
			// What a redirected window sends after its attach was meant for the
			// child: it is read and dropped, so the window's end is read too and
			// its connection goes (F57).
			if (redirected) return;
			socket.pause();
			void (async () => {
				const values = frames.push(
					typeof chunk === "string" ? Buffer.from(chunk) : chunk,
				);
				for (const [at, value] of values.entries()) {
					if (socket.destroyed || ended) break;
					const child = await receive(value);
					if (redirected) {
						socket.resume();
						return;
					}
					if (child) {
						passed = true;
						passOn(child, values.slice(at + 1), frames.rest());
						return;
					}
				}
				socket.resume();
			})().catch((error) => {
				options.report(error);
				socket.destroy();
			});
		}
		socket.on("data", received);
		socket.on("end", () => {
			// Half a line after a redirect was the child's to read, not a fault
			// (F58).
			if (passed || redirected) return detach();
			try {
				frames.end();
			} catch (error) {
				options.report(error);
			}
			detach();
		});
		socket.on("close", detach);
		socket.on("error", (error) => {
			options.report(error);
		});
	});
	try {
		try {
			await bind(server, options.path);
		} catch (error) {
			if (errorCode(error) !== "EADDRINUSE" || !(await abandoned(options.path)))
				throw error;
			await unlink(options.path);
			await bind(server, options.path);
		}
		await chmod(options.path, SOCKET_MODE);
		ready = true;
	} catch (error) {
		if (server.listening) server.close();
		throw error;
	}
	server.on("error", options.report);
	// Stops taking connections at once; settles once every one has ended.
	let listening: Promise<void> | undefined;
	const stopListening = () => {
		ready = false;
		listening ??= new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
		return listening;
	};
	return {
		/**
		 * Tell every attached viewer the host is about to restart, and end
		 * its connection once the frame is out, so a client that knows the
		 * frame joins the same conversation again once the next host
		 * listens; an older one passes it over. Settles once each viewer has
		 * gone, or after RESTART_FLUSH_MS, whichever comes first.
		 */
		async restarting(): Promise<void> {
			// A client told of the restart joins again at once, so this host
			// takes no more connections: one it took would end at its close,
			// with no frame to say why.
			// close() awaits the same promise, and reports how it ended.
			stopListening().catch(() => undefined);
			const leaving = [
				...[...viewing].map(([socket, send]) => ({
					socket,
					leave: () => {
						send({ type: "restarting" });
						socket.end();
					},
				})),
				// One passed on to a child says so once the child's frame ends.
				...[...passing].map(([socket, leave]) => ({ socket, leave })),
			].map(
				({ socket, leave }) =>
					new Promise<void>((resolve) => {
						if (socket.destroyed) return resolve();
						socket.once("close", () => resolve());
						leave();
					}),
			);
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([
				Promise.all(leaving),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, RESTART_FLUSH_MS);
				}),
			]);
			clearTimeout(timer);
		},
		async close(): Promise<void> {
			const closed = stopListening();
			const answers = [...answering].map(([socket, sent]) =>
				sent.then(() => endWhenWritten(socket)),
			);
			let timer: NodeJS.Timeout | undefined;
			await Promise.all([
				...[...watching].map(endWhenWritten),
				Promise.race([
					Promise.all(answers),
					new Promise<void>((resolve) => {
						// An answer that never comes holds a close no longer than a watcher's.
						timer = setTimeout(resolve, RESTART_FLUSH_MS);
					}),
				]),
			]);
			clearTimeout(timer);
			for (const socket of sockets) socket.destroy();
			await closed;
		},
	};
}
