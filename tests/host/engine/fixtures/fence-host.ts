/**
 * Hosts whose records lie in a closed state folder of their own, for
 * the tests of what a host's record says of each session's fence; each
 * is put down, and its folder removed, by `putDown` after a test.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ConversationRegistration,
	SessionHost,
} from "../../../../host/engine/index.ts";
import type { FenceKind } from "../../../../lib/mesh/presence.ts";

export const owner = {
	pid: 123,
	startedAt: 1000,
	bootId: "boot",
	startTicks: 20,
};
const hosts: SessionHost[] = [];
const directories: string[] = [];

/** Put down each host a test started, and remove its folders. */
export async function putDown(): Promise<void> {
	for (const host of hosts.splice(0)) {
		for (const { id } of host.list()) await host.close(id);
		host.dispose();
	}
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
}

/** A closed state folder of its own, spelled as it really is. */
export function closedState(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "session-host-fence-")));
	directories.push(dir);
	return dir;
}

export function start(
	state = closedState(),
	registryDir = join(state, "agentic-harness.pi/hosts"),
): SessionHost {
	const host = new SessionHost({
		key: "test-host",
		owner,
		registryDir,
		closedState: state,
	});
	hosts.push(host);
	return host;
}

export function registration(
	id: string,
	extra: Partial<ConversationRegistration> = {},
): ConversationRegistration {
	return {
		id,
		file: `/sessions/${id}.jsonl`,
		cwd: `/repo/${id}`,
		env: {},
		hints: {},
		close: () => {},
		...extra,
	};
}

/** Each session's fence, as the host's record says it. */
export function fences(host: SessionHost): Record<string, unknown> {
	const read = JSON.parse(readFileSync(host.registryPath, "utf8")) as {
		sessions: { id: string; fence?: unknown }[];
	};
	return Object.fromEntries(read.sessions.map(({ id, fence }) => [id, fence]));
}

/** A runner starting, its file guard and then its shell telling the host. */
export function told(host: SessionHost, id: string, fence: FenceKind): void {
	host.fenced(id, fence, "files");
	host.fenced(id, fence, "shell");
}
