/**
 * The engine a sealed host runs until H1's createEngine lands: each
 * conversation is a registration over the real SessionHost, as H1's
 * engine makes one, with no pi behind it. Its session files go under the
 * host's own HOME, so a test can see the seal reached the host process.
 *
 * A host process imports this by path, under node's own type stripping,
 * so it holds nothing node can't strip.
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionHost } from "../../../../host/engine/index.ts";
import type { ConversationEngine } from "../../../../host/service/backend.ts";

/** Build the fake engine over a host's ownership. */
export async function engine(host: SessionHost): Promise<ConversationEngine> {
	const sessions = join(homedir(), "sessions");
	await mkdir(sessions, { recursive: true });
	const register = (c: { sessionId: string; file: string; cwd: string }) =>
		host.register({
			id: c.sessionId,
			file: c.file,
			cwd: c.cwd,
			env: { HOME: homedir() },
			close: () => {},
		});
	return {
		prepare: async (request) => ({
			sessionId: randomUUID(),
			file: join(sessions, `${randomUUID()}.jsonl`),
			cwd: request.op === "open" ? request.cwd : sessions,
		}),
		start: async (prepared) => register(prepared),
		discard: async () => {},
		resume: async (entry) => register(entry),
		abort: async () => {},
	};
}
