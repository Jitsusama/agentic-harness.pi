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
import { type ControlBackend, dispatchControl } from "./dispatch.ts";
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
}) {
	if (!isAbsolute(options.path))
		throw new Error("Host socket path must be absolute");
	await privateDirectory(dirname(options.path));
	const sockets = new Set<Socket>();
	// How to reach each connection a viewer is attached on.
	const viewing = new Map<Socket, (value: unknown) => void>();
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
		function detach() {
			if (ended) return;
			ended = true;
			if (viewer && sessionId) {
				const attached = viewer;
				try {
					withSession(sessionId, () => attached.detach());
				} catch (error) {
					options.report(error);
				}
			}
			viewing.delete(socket);
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
		async function receive(value: unknown) {
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
				["close", "release", "abort"].includes(request.op) &&
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
			const reply = await dispatchControl(
				request,
				options.backend,
				options.report,
			);
			send(reply);
			if (
				reply.ok &&
				request.op === "attach" &&
				options.viewer &&
				!socket.destroyed &&
				!ended
			) {
				sessionId = request.sessionId;
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
		}
		socket.on("data", (chunk) => {
			socket.pause();
			void (async () => {
				for (const value of frames.push(
					typeof chunk === "string" ? Buffer.from(chunk) : chunk,
				)) {
					if (socket.destroyed || ended) break;
					await receive(value);
				}
				socket.resume();
			})().catch((error) => {
				options.report(error);
				socket.destroy();
			});
		});
		socket.on("end", () => {
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
			const leaving = [...viewing].map(
				([socket, send]) =>
					new Promise<void>((resolve) => {
						if (socket.destroyed) return resolve();
						socket.once("close", () => resolve());
						send({ type: "restarting" });
						socket.end();
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
