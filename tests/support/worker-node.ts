/**
 * A stand-in for a node's worker socket, and a link opened to it as a
 * worker's session would, for the worker link's tests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { ENVELOPE, type Message } from "../../lib/mesh/message.ts";
import type { Presence } from "../../lib/mesh/presence.ts";
import {
	createWorkerLink,
	type Refused,
	type WorkerLink,
} from "../../lib/mesh/worker-link.ts";

/** The test's own folder, made afresh for each. */
export let dir: string;
let path: string;
let server: Server | undefined;
/** Every connection the stand-in node took, to end after each test. */
let accepted: Socket[] = [];
/** The link the test opened, closed after each. */
export let link: WorkerLink | undefined;

/** One connection to the stand-in node, and every line it said. */
export interface Connection {
	readonly socket: Socket;
	readonly said: unknown[];
}

/** A stand-in worker socket: its connections, in the order they came. */
export interface Node {
	readonly connections: Connection[];
}

/** How the stand-in node answers one line on a connection. */
export type Answer = (
	asked: Record<string, unknown>,
	on: Connection,
) => string[];

/** The node as agreed: Present, Sent whole, Watching then what it holds. */
export const agreed =
	(held: readonly Message[] = []): Answer =>
	(asked) => {
		if ("Presence" in asked) return ['{"Ok":"Present"}'];
		if ("Send" in asked) {
			const sent = asked["Send"];
			const message =
				typeof sent === "object" && sent !== null && "message" in sent
					? sent.message
					: undefined;
			return [JSON.stringify({ Ok: { Sent: message } })];
		}
		if ("Watch" in asked) {
			return [
				'{"Ok":"Watching"}',
				JSON.stringify({ MessagesChanged: { messages: held } }),
			];
		}
		return ['{"Err":"not asked of a worker"}'];
	};

/** Serves `path`, answering each line as `answer` says. */
export async function node(answer: Answer): Promise<Node> {
	const heard: Node = { connections: [] };
	server = createServer((socket) => {
		accepted.push(socket);
		const on: Connection = { socket, said: [] };
		heard.connections.push(on);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			for (const line of chunk.split("\n").filter(Boolean)) {
				const asked: Record<string, unknown> = JSON.parse(line);
				on.said.push(asked);
				for (const reply of answer(asked, on)) socket.write(`${reply}\n`);
			}
		});
	});
	const listening = server;
	await new Promise<void>((done) => listening.listen(path, done));
	return heard;
}

/** A presence as a worker's session says it. */
export function presence(session = "sess-1"): Presence {
	return {
		session,
		addresses: ["W0RK3R"],
		groups: ["#quest/w0rk3r"],
		worksOn: "work in the cloud",
		owns: [],
		busy: false,
		at: "2026-11-24T06:00:00.000Z",
	};
}

/** A message as the mesh stamps it. */
export function message(id: string, text = "hello"): Message {
	return {
		v: ENVELOPE,
		id,
		at: "2026-11-24T06:00:00.000Z",
		from: "W0RK3R",
		to: ["KP0L6A"],
		intent: "fyi",
		text,
		pid: 42,
	};
}

/**
 * An id stamped `ago` before now by `from`, as the mesh mints them: real
 * 13-digit stamps, so a test of take-up orders them as the node will.
 */
export function stamped(ago: number, from = "KP0L6A", tail = "aa"): string {
	return `${Date.now() - ago}-${from}-7-${tail}`;
}

/** A message as kept from the watch: from elsewhere, read by address. */
export function heardAs(one: Message): Message {
	return { ...one, hosted: true };
}

/** What a session using the link has been handed. */
export interface Session {
	readonly kept: Message[];
	readonly refused: Refused[];
	reachedAgain: number;
}

/** Opens a link to the stand-in node, as a worker's session would. */
export function linked(
	held: readonly string[] = [],
	keep: (one: Message) => void = () => undefined,
	lastRead?: () => string | undefined,
	mostLine?: number,
): Session {
	const session: Session = { kept: [], refused: [], reachedAgain: 0 };
	link = createWorkerLink({
		socket: path,
		keep: (one) => {
			keep(one);
			session.kept.push(one);
		},
		held: () => held,
		...(lastRead ? { lastRead } : {}),
		refused: (one) => session.refused.push(one),
		reachedAgain: () => {
			session.reachedAgain += 1;
		},
		retryMs: 10,
		...(mostLine === undefined ? {} : { mostLine }),
	});
	return session;
}

/** Makes each test's folder, and ends its node and link after it. */
export function useStandInNode(): void {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "worker-link-"));
		path = join(dir, "worker.sock");
	});
	afterEach(async () => {
		link?.close();
		link = undefined;
		const closing = server;
		server = undefined;
		for (const socket of accepted) socket.destroy();
		accepted = [];
		if (closing) {
			await new Promise((done) => closing.close(done));
		}
		rmSync(dir, { recursive: true, force: true });
	});
}
