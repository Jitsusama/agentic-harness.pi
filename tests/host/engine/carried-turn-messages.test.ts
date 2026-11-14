/** An extension's message held through a turn the host carries on, as pi holds one through its own run. */
import { describe, expect, it } from "vitest";
import {
	type CarryingAgent,
	holdMessagesThroughCarriedTurns,
	type MessagingSession,
} from "../../../host/engine/carried-turn-messages.ts";
import type {
	CustomMessageInput,
	CustomMessageOptions,
} from "../../../host/engine/pi-session.ts";
import type { AgentMessage } from "../../../host/engine/pi-types.ts";

/** A session and agent that note what reached each, the agent running a turn the session counts no run for. */
function carrying(refusing = false) {
	const written: string[] = [];
	const queued: string[] = [];
	const reported: unknown[] = [];
	const listeners = new Set<(event: { readonly type: string }) => void>();
	const state = { isStreaming: true };
	const session: MessagingSession & { isStreaming: boolean } = {
		isStreaming: false,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async sendCustomMessage(message: CustomMessageInput) {
			if (refusing) throw new Error("the file is closed");
			written.push(String(message.content));
		},
		dispose() {
			written.push("disposed");
		},
	};
	const agent: CarryingAgent = {
		state,
		steer: (message: AgentMessage) => queued.push(`steer ${message.content}`),
		followUp: (message: AgentMessage) =>
			queued.push(`followUp ${message.content}`),
	};
	const undo = holdMessagesThroughCarriedTurns(session, agent, (error) =>
		reported.push(error),
	);
	const send = (content: string, options?: CustomMessageOptions) =>
		session.sendCustomMessage(
			{ customType: "mesh", content, display: true },
			options,
		);
	const emit = (type: string) => {
		for (const listener of listeners) listener({ type });
	};
	return { session, state, written, queued, reported, send, emit, undo };
}

describe("an extension's message during a turn the host carries on", () => {
	it("is written once the turn ends when it asks for no turn", async () => {
		const { send, emit, written } = carrying();
		await send("a word", { triggerTurn: false });
		expect(written, "nothing written mid-round").toEqual([]);
		emit("turn_end");
		expect(written).toEqual(["a word"]);
	});

	it("is written as the run ends when no turn ends first", async () => {
		const { send, emit, written } = carrying();
		await send("a word", { triggerTurn: false });
		emit("agent_end");
		expect(written).toEqual(["a word"]);
	});

	it("is written as the session is disposed when no turn ends first", async () => {
		const { session, send, written } = carrying();
		await send("a word", { triggerTurn: false });
		session.dispose();
		expect(written).toEqual(["a word", "disposed"]);
	});

	it("lets go of the session as it is disposed", async () => {
		const { session, send, emit, written } = carrying();
		session.dispose();
		await send("after", { triggerTurn: false });
		emit("turn_end");
		expect(written).toEqual(["disposed", "after"]);
	});

	it("keeps its order with the others held beside it", async () => {
		const { send, emit, written } = carrying();
		await send("first", { triggerTurn: false });
		await send("second", { triggerTurn: false });
		emit("turn_end");
		expect(written).toEqual(["first", "second"]);
	});

	it("is steered into the turn, or followed up, when it asks for one", async () => {
		const { send, written, queued } = carrying();
		await send("steered");
		await send("followed", { triggerTurn: true, deliverAs: "followUp" });
		expect(queued).toEqual(["steer steered", "followUp followed"]);
		expect(written, "nothing written to the file").toEqual([]);
	});

	it("is reported when pi's session fails to write it", async () => {
		const { send, emit, reported } = carrying(true);
		await send("a word", { triggerTurn: false });
		emit("turn_end");
		// The failed write reaches report a few microtasks on; one turn of the event loop outlasts them.
		await new Promise((settle) => setImmediate(settle));
		expect(reported.map(String)).toEqual(["Error: the file is closed"]);
	});

	it("goes to pi's session as sent when it is for the next turn", async () => {
		const { send, written } = carrying();
		await send("later", { triggerTurn: false, deliverAs: "nextTurn" });
		expect(written).toEqual(["later"]);
	});
});

describe("an extension's message outside such a turn", () => {
	it("goes to pi's session as sent while pi's session counts its own run", async () => {
		const { session, send, written } = carrying();
		session.isStreaming = true;
		await send("a word", { triggerTurn: false });
		expect(written).toEqual(["a word"]);
	});

	it("goes to pi's session as sent while the agent is idle", async () => {
		const { state, send, written } = carrying();
		state.isStreaming = false;
		await send("a word", { triggerTurn: false });
		expect(written).toEqual(["a word"]);
	});

	it("goes to pi's session as sent once the hold is undone", async () => {
		const { undo, send, written } = carrying();
		undo();
		await send("a word", { triggerTurn: false });
		expect(written).toEqual(["a word"]);
	});
});
