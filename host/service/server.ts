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
import { type ChildRoutes, passedOn } from "./children.ts";
import {
	type ControlBackend,
	dispatchControl,
	sameHost,
	staleHost,
} from "./dispatch.ts";
import { jsonLines } from "./framing.ts";
import { type ControlRequest, parseControl, parseViewer } from "./protocol.ts";

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

/** A connection passed on to the child running its conversation, and its opening bytes. */
interface PassedOn {
	child: Socket;
	line: string;
	/** Whether a window attaches on it, which a restart tells by a frame. */
	viewing: boolean;
}

/** Connect to a child's socket, or fail as the kernel says it can't be reached. */
function reach(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const child = createConnection(path);
		child.once("connect", () => {
			child.off("error", reject);
			resolve(child);
		});
		child.once("error", reject);
	});
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
	 * to its child's socket, and the connection with it, so the child
	 * answers it, and a window attached to it, on a thread of its own.
	 */
	children?: ChildRoutes;
}) {
	if (!isAbsolute(options.path))
		throw new Error("Host socket path must be absolute");
	await privateDirectory(dirname(options.path));
	const sockets = new Set<Socket>();
	// How to reach each connection a viewer is attached on.
	const viewing = new Map<Socket, (value: unknown) => void>();
	// How to end each connection passed on to a child, at a frame's edge.
	const passing = new Map<Socket, () => void>();
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
			viewing.delete(socket);
			passing.delete(socket);
			sockets.delete(socket);
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
		 * Hand the connection to the child: what it was sent from the request
		 * on goes to the child as bytes, and what the child answers comes
		 * back as bytes, so neither is decoded on this thread again.
		 */
		function passOn(
			{ child, line, viewing: attached }: PassedOn,
			after: readonly unknown[],
			rest: Buffer,
		) {
			socket.off("data", received);
			let atEdge = true;
			let leaving = false;
			const leave = () => {
				socket.write(`${JSON.stringify({ type: "restarting" })}\n`);
				socket.end();
				child.destroy();
			};
			// A request's one answer is left to come: a frame after it would
			// read as a second answer.
			if (attached)
				passing.set(socket, () => {
					leaving = true;
					if (atEdge) leave();
				});
			child.on("data", (chunk: Buffer) => {
				if (socket.destroyed) return;
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
			});
			socket.on("drain", () => child.resume());
			child.on("end", () => socket.end());
			child.on("close", () => socket.end());
			child.on("error", (error) => {
				options.report(error);
				socket.destroy();
			});
			socket.on("close", () => child.destroy());
			child.write(line);
			for (const value of after) child.write(`${JSON.stringify(value)}\n`);
			if (rest.length) child.write(rest);
			socket.pipe(child);
		}
		async function receive(value: unknown): Promise<PassedOn | undefined> {
			if (viewer && sessionId) {
				const input = parseViewer(value);
				const attached = viewer;
				withSession(sessionId, () => {
					if (input.type === "input") attached.input(input.data);
					else if (input.type === "resize")
						attached.resize(input.rows, input.columns);
					else attached.edited?.(input.id, input.text);
				});
				return;
			}
			let request: ControlRequest;
			try {
				request = parseControl(value);
			} catch {
				send(await dispatchControl(value, options.backend, options.report));
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
			if (route) {
				// The caller named this host, so this host checks it; the child
				// is asked under its own name.
				if (
					request.expectedHost &&
					!sameHost(request.expectedHost, options.backend.identity)
				) {
					send(staleHost(request.id));
					return;
				}
				try {
					const child = await reach(route.socket);
					if (socket.destroyed || ended) {
						child.destroy();
						return;
					}
					return {
						child,
						line: `${JSON.stringify(passedOn(request, route))}\n`,
						viewing: request.op === "attach",
					};
				} catch (error) {
					options.report(error);
					send({
						v: 1,
						id: request.id,
						ok: false,
						error: {
							code: "child_unreachable",
							message: "The process running this conversation does not answer",
						},
					});
					return;
				}
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
			const reply = await dispatchControl(
				request,
				options.backend,
				options.report,
			);
			send(reply);
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
			socket.pause();
			void (async () => {
				const values = frames.push(
					typeof chunk === "string" ? Buffer.from(chunk) : chunk,
				);
				for (const [at, value] of values.entries()) {
					if (socket.destroyed || ended) break;
					const child = await receive(value);
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
			if (passed) return detach();
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
			for (const socket of sockets) socket.destroy();
			await closed;
		},
	};
}
