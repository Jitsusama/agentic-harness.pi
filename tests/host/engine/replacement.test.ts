/**
 * A runtime's replacements held to the host: a held target is refused
 * before pi tears anything down; what pi runs for the next session runs as
 * the next conversation; and the host hears a replacement settled, lost
 * past the teardown, or not at all when pi stopped short of it. The runtime
 * here plays pi's order of steps; tests/host/engine/engine.test.ts runs
 * pi's own.
 */
import { describe, expect, it } from "vitest";
import type {
	AgentSession,
	AgentSessionRuntime,
} from "../../../host/engine/pi-session.ts";
import {
	holdReplacements,
	type ReplacementHold,
} from "../../../host/engine/replacement.ts";
import {
	ambientSession,
	withSession,
} from "../../../lib/core/session/index.ts";

/** Where pi's replacement fails, if it does. */
type Failing = "before teardown" | "after teardown" | undefined;

/** A runtime that replaces its session in pi's order: check, teardown, build, rebind, callback. */
function fakeRuntime(failing?: Failing) {
	let rebind: ((session: AgentSession) => Promise<void>) | undefined;
	let invalidate: (() => void) | undefined;
	const fake = {
		session: { sessionId: "first" },
		setRebindSession(next?: (session: AgentSession) => Promise<void>) {
			rebind = next;
		},
		setBeforeSessionInvalidate(next?: () => void) {
			invalidate = next;
		},
		async newSession(options?: {
			withSession?: (context: object) => Promise<void>;
		}) {
			return replace(options?.withSession);
		},
		async switchSession(
			_path: string,
			options?: { withSession?: (context: object) => Promise<void> },
		) {
			return replace(options?.withSession);
		},
	};
	async function replace(
		callback?: (context: object) => Promise<void>,
	): Promise<{ cancelled: boolean }> {
		if (failing === "before teardown")
			throw new Error("the session's folder is gone");
		invalidate?.();
		if (failing === "after teardown") throw new Error("the build failed");
		fake.session = { sessionId: "next" };
		// The fake's session carries only the id the hold reads.
		await rebind?.(fake.session as unknown as AgentSession);
		await callback?.({});
		return { cancelled: false };
	}
	// The fake carries only what holdReplacements and these tests reach of pi's runtime.
	return fake as unknown as AgentSessionRuntime;
}

/** A hold that notes what it hears, refusing the files it is told are held. */
function noting(heldFiles: readonly string[] = []) {
	const heard: string[] = [];
	const hold: ReplacementHold = {
		refuse: (file) => {
			if (heldFiles.includes(file)) throw new Error(`held: ${file}`);
		},
		replaced: async (previousId) => {
			heard.push(`replaced ${previousId}`);
		},
		lost: async (previousId, error) => {
			heard.push(`lost ${previousId}: ${String(error)}`);
		},
	};
	return { hold, heard };
}

describe("holding a runtime's replacements", () => {
	it("settles a replacement, its rebinding and callback running as the next conversation", async () => {
		const runtime = fakeRuntime();
		const { hold, heard } = noting();
		holdReplacements(runtime, hold);
		const ranAs: (string | undefined)[] = [];
		runtime.setRebindSession(async () => {
			ranAs.push(ambientSession());
		});
		await withSession("first", () =>
			runtime.newSession({
				withSession: async () => {
					ranAs.push(ambientSession());
				},
			}),
		);
		expect(ranAs).toEqual(["next", "next"]);
		expect(heard).toEqual(["replaced first"]);
	});

	it("refuses a held target before pi tears anything down", async () => {
		const runtime = fakeRuntime();
		const { hold, heard } = noting(["/sessions/held.jsonl"]);
		let invalidated = false;
		holdReplacements(runtime, hold);
		runtime.setBeforeSessionInvalidate(() => {
			invalidated = true;
		});
		await expect(
			runtime.switchSession("/sessions/../sessions/held.jsonl"),
		).rejects.toThrow("held: /sessions/held.jsonl");
		expect(invalidated).toBe(false);
		expect(runtime.session.sessionId).toBe("first");
		expect(heard).toEqual([]);
	});

	it("says a conversation lost when pi fails past its teardown", async () => {
		const runtime = fakeRuntime("after teardown");
		const { hold, heard } = noting();
		holdReplacements(runtime, hold);
		await expect(runtime.newSession()).rejects.toThrow("the build failed");
		expect(heard).toEqual(["lost first: Error: the build failed"]);
	});

	it("leaves the conversation as it was when pi fails before its teardown", async () => {
		const runtime = fakeRuntime("before teardown");
		const { hold, heard } = noting();
		holdReplacements(runtime, hold);
		await expect(runtime.newSession()).rejects.toThrow("folder is gone");
		expect(heard).toEqual([]);
	});

	it("still runs a screen's own invalidate callback", async () => {
		const runtime = fakeRuntime();
		const { hold } = noting();
		holdReplacements(runtime, hold);
		let invalidated = 0;
		runtime.setBeforeSessionInvalidate(() => {
			invalidated++;
		});
		await runtime.newSession();
		expect(invalidated).toBe(1);
	});
});
