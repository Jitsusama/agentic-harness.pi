/** Run records reach only the producer's conversation, across sibling shutdown. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	registerRunRecorder,
	runRecordFrom,
} from "../../../lib/core/observability/index.ts";
import { recordRunEverywhere } from "../../../lib/core/observability/recorder.ts";
import {
	NoSessionInHost,
	withSession,
} from "../../../lib/core/session/index.ts";
import { installTestHost } from "../../support/session-host.ts";

const record = runRecordFrom({
	runId: "run",
	subagentId: "child",
	kind: "fleet",
	model: "mock",
	persona: "test",
	thinkingLevel: null,
	startedAt: 0,
	result: { exitCode: 0, sessionIds: [], warnings: [] },
});
let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

describe("hosted run recorders", () => {
	it("records only to the owner and preserves B's sink after A closes", async () => {
		const installed = installTestHost();
		dispose = installed.dispose;
		const a = vi.fn();
		const b = vi.fn();
		withSession("a", () => registerRunRecorder(a));
		registerRunRecorder(b, { sessionManager: { getSessionId: () => "b" } });
		withSession("a", () => recordRunEverywhere(record));
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).not.toHaveBeenCalled();
		withSession("b", () => recordRunEverywhere(record));
		await installed.host.close("a", "done");
		withSession("b", () => recordRunEverywhere(record));
		expect(b).toHaveBeenCalledTimes(2);
		expect(a).toHaveBeenCalledTimes(1);
	});

	it("binds disposers to their registry rather than their calling context", () => {
		const installed = installTestHost();
		dispose = installed.dispose;
		const shared = vi.fn();
		const stopA = registerRunRecorder(shared, "a");
		registerRunRecorder(shared, "b");
		withSession("b", stopA);
		withSession("a", () => recordRunEverywhere(record));
		expect(shared).not.toHaveBeenCalled();
		withSession("b", () => recordRunEverywhere(record));
		expect(shared).toHaveBeenCalledTimes(1);
		expect(() => recordRunEverywhere(record)).toThrow(NoSessionInHost);
	});

	it("does not let a broken sink stop another sink in the same session", () => {
		const installed = installTestHost();
		dispose = installed.dispose;
		const kept = vi.fn();
		registerRunRecorder(() => {
			throw new Error("broken sink");
		}, "b");
		registerRunRecorder(kept, "b");
		withSession("b", () => recordRunEverywhere(record));
		expect(kept).toHaveBeenCalledWith(record);
	});
});
