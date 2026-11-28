/**
 * A hosted open's first words stop being pending however its build ends:
 * handed on to pi once the open is built, or given up when the build
 * fails before that, so nothing waits on them for ever. The build runs on
 * fakes standing in for pi's runtime, its screen and the host's agent.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type BuildContext,
	conversationBuilds,
	type Live,
} from "../../../host/engine/conversation-build.ts";
import type { SessionManager } from "../../../host/engine/pi-session.ts";
import { withSession } from "../../../lib/core/session/index.ts";
import { firstPromptPending } from "../../../lib/internal/session/first-prompt.ts";
import { installTestHost } from "../../support/session-host.ts";

let installed: ReturnType<typeof installTestHost>;
let folder: string;
beforeEach(() => {
	installed = installTestHost();
	folder = mkdtempSync(join(tmpdir(), "first-words-"));
});
afterEach(() => {
	installed.dispose();
	rmSync(folder, { recursive: true, force: true });
});

/** What the build saw of the first words while it ran. */
interface Seen {
	/** Whether they were pending when the agent began its recovery. */
	pendingAtRecovery?: boolean;
	/** The words pi was handed, in order. */
	prompted: string[];
}

/**
 * Build conversation "a", opened with `first`, on fakes: pi's runtime
 * holds the host's agent, whose recovery is `recover`, and pi takes any
 * words it is handed at once. What it saw fills `seen` as it builds.
 */
async function open(
	first: string,
	recover: () => Promise<{ settled: Promise<void> }>,
	seen: Seen,
): Promise<void> {
	const file = join(folder, "a.jsonl");
	// Written already, so the build opens it as it is rather than writing it.
	writeFileSync(file, "");
	const record = {
		traits: { sessionId: "a", file, cwd: folder, attended: true },
		launch: {},
	} as unknown as Live;
	const agent = {
		recover: () => {
			seen.pendingAtRecovery = firstPromptPending();
			return recover();
		},
		watchWords: () => ({
			held: Promise.resolve(),
			told: () => {},
		}),
	};
	const session = {
		sessionId: "a",
		subscribe: () => () => {},
		extensionRunner: { getCommand: () => undefined },
		prompt: async (words: string) => {
			seen.prompted.push(words);
		},
	};
	const runtime = {
		session,
		setBeforeSessionInvalidate: () => {},
		setRebindSession: () => {},
	};
	const context = {
		parts: {
			sessions: {
				getAgentDir: () => folder,
				createAgentSessionRuntime: async () => {
					// As pi's factory would, once the session holds the host's agent.
					record.conversation = { agent } as unknown as Live["conversation"];
					return runtime;
				},
			},
		},
		options: { screens: { opened: async () => {} } },
		report: () => {},
		stopping: { reap: async () => {} },
		heard: () => {},
	} as unknown as BuildContext;
	const manager = {
		getSessionFile: () => file,
	} as unknown as SessionManager;
	await withSession("a", () =>
		conversationBuilds(context).build(record, manager, {
			v: 1,
			id: "a",
			op: "open",
			cwd: folder,
			attended: true,
			first,
		}),
	);
}

describe("a hosted open's first words", () => {
	it("are pending while the open builds, and no longer once it hands them on", async () => {
		const seen: Seen = { prompted: [] };

		await open("hello", async () => ({ settled: Promise.resolve() }), seen);

		expect(seen.pendingAtRecovery, "pending while the open built").toBe(true);
		expect(seen.prompted, "handed to pi").toEqual(["hello"]);
		expect(
			withSession("a", firstPromptPending),
			"no longer pending once handed on",
		).toBe(false);
	});

	it("are no longer pending once a build that fails before handing them on ends", async () => {
		const refused = new Error("durable refused the recovery");
		const seen: Seen = { prompted: [] };

		await expect(
			open("hello", () => Promise.reject(refused), seen),
			"the build fails with the recovery",
		).rejects.toBe(refused);

		expect(seen.pendingAtRecovery, "pending while the open built").toBe(true);
		expect(seen.prompted, "never handed to pi").toEqual([]);
		expect(
			withSession("a", firstPromptPending),
			"no longer pending, though pi was never handed them",
		).toBe(false);
	});
});
