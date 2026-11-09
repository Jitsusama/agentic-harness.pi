/** Private Unix listener and bounded viewer transport; session work stays in the engine. */
import { chmod, lstat, mkdir } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { withSession } from "../../lib/core/session/index.ts";
import { type ControlBackend, dispatchControl } from "./dispatch.ts";
import { jsonLines } from "./framing.ts";
import { type ControlRequest, parseControl, parseViewer } from "./protocol.ts";

const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const SOCKET_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/** One viewer's connection to a persistent Terminal, not the session itself. */
export interface ViewerConnection {
	input(data: string): void;
	resize(rows: number, columns: number): void;
	detach(): void;
}

/** V supplies a Terminal attachment; H2 supplies framed output and EOF handling. */
export interface ViewerBridge {
	attach(
		request: Extract<ControlRequest, { op: "attach" }>,
		sink: {
			write(data: string): void;
			disconnect(reason: string): void;
		},
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

/** Listen without taking over an existing socket; stop detaches viewers, not sessions. */
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
			sockets.delete(socket);
		}
		function send(value: unknown) {
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
					else attached.resize(input.rows, input.columns);
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
						write: (data) => send({ type: "output", data }),
						disconnect: (reason) => {
							send({ type: "detached", reason });
							socket.end();
						},
					}),
				);
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
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.path, () => {
				server.off("error", reject);
				resolve();
			});
		});
		await chmod(options.path, SOCKET_MODE);
		ready = true;
	} catch (error) {
		if (server.listening) server.close();
		throw error;
	}
	server.on("error", options.report);
	return {
		async close(): Promise<void> {
			ready = false;
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}
