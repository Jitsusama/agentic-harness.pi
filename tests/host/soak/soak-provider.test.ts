/**
 * What the soak's provider answers each request with: each kind of
 * turn's own answer, the work before it at a pace, what follows a steer
 * and a compaction's summary, and the holds the soak arms on a turn's
 * own answer so a steer or an abort lands mid-turn.
 */
import { describe, expect, it } from "vitest";
import { answerTo, JOB, ownAnswerOf, soakProvider } from "./soak-provider.ts";
import { steerOf, summaryOf } from "./turns.ts";

describe("the soak's provider", () => {
	const user = (text: string) => ({ role: "user", content: text });
	const result = {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: "call_1", content: "ok" }],
	};

	it("echoes an echo turn, acknowledging its tag", () => {
		expect(answerTo([user("soak c0-t1 echo, please")]), "an echo").toEqual({
			type: "text",
			text: "heard, ack c0-t1.",
		});
	});

	it("runs a job turn's bash in the background", () => {
		expect(answerTo([user("soak c0-t7 job, please")]), "a job").toEqual({
			type: "tool_use",
			name: "bash",
			input: { command: JOB, background: true },
		});
	});

	it("acknowledges a tool's result with the turn's tag", () => {
		expect(
			answerTo([
				user("soak c2-t0 read, please"),
				{ role: "assistant" },
				result,
			]),
			"after the read",
		).toEqual({ type: "text", text: "done, ack c2-t0." });
	});

	it("ends a long answer on its acknowledgement", () => {
		const block = answerTo([user("soak c0-t11 long, please")]);
		const text = block.type === "text" ? block.text : "";
		expect(text.split("\n").length, "120 lines").toBe(120);
		expect(text.endsWith("ack c0-t11."), text.slice(-40)).toBe(true);
	});

	it("answers a request with no soak prompt in it all the same", () => {
		expect(answerTo([user("name this session")]), "unscripted").toEqual({
			type: "text",
			text: "soak mock",
		});
	});

	it("runs a steer turn's bash, then acknowledges the words it was steered with", () => {
		const asked = [user("soak c1-t5 steer, please")];
		expect(answerTo(asked), "the steer turn's own answer").toEqual({
			type: "tool_use",
			name: "bash",
			input: { command: "echo soak steer c1-t5" },
		});
		expect(
			answerTo([
				...asked,
				{ role: "assistant" },
				result,
				user(steerOf("c1-t5")),
			]),
			"once steered",
		).toEqual({ type: "text", text: "steered, ack c1-t5." });
	});

	it("summarises a compaction by the focus that follows the conversation it serialises", () => {
		const summary = user(
			"<conversation>\n[User]: soak c0-t13 echo, please\n</conversation>\n\nAdditional focus: soak c0-t14 compact, please",
		);
		expect(answerTo([summary]), "the summary").toEqual({
			type: "text",
			text: summaryOf("c0-t14"),
		});
	});

	it("says which turn's own answer a request asks for, and none for its work, its end or a compaction", () => {
		const asked = [user("soak c1-t5 steer, please")];
		expect(ownAnswerOf(asked), "the steer's own").toBe("c1-t5");
		expect(
			ownAnswerOf([...asked, { role: "assistant" }, result]),
			"after its tool",
		).toBe(undefined);
		expect(
			ownAnswerOf([
				...asked,
				{ role: "assistant" },
				result,
				user(steerOf("c1-t5")),
			]),
			"once steered",
		).toBe(undefined);
		expect(
			ownAnswerOf([user("soak c0-t14 compact, please")]),
			"a summary",
		).toBe(undefined);
		expect(
			ownAnswerOf([user("soak c0-t1 echo, please")], {
				rounds: { p50: 3, p90: 3 },
			}),
			"an echo's first round of work at a pace",
		).toBe(undefined);
	});
});

describe("the soak's provider, holding an answer", () => {
	const asking = (endpoint: string, text: string, signal?: AbortSignal) =>
		fetch(`${endpoint}/v1/messages`, {
			method: "POST",
			body: JSON.stringify({ messages: [{ role: "user", content: text }] }),
			...(signal ? { signal } : {}),
		});

	it("holds a turn's own answer until let go, and only once", async () => {
		const provider = await soakProvider();
		try {
			provider.hold("c0-t1");
			let answered = false;
			const first = asking(provider.endpoint, "soak c0-t1 echo, please").then(
				async (response) => {
					answered = true;
					return response.text();
				},
			);
			await provider.held("c0-t1", 5000);
			expect(answered, "nothing answered while held").toBe(false);
			provider.release("c0-t1");
			expect(await first, "answered once let go").toContain("ack c0-t1.");
			const again = await asking(provider.endpoint, "soak c0-t1 echo, please");
			expect(await again.text(), "asked again, answered at once").toContain(
				"ack c0-t1.",
			);
		} finally {
			await provider.close();
		}
	});

	it("lets a held answer's client go, holding the turn no longer", async () => {
		const provider = await soakProvider();
		try {
			provider.hold("c0-t9");
			const cut = new AbortController();
			const first = asking(
				provider.endpoint,
				"soak c0-t9 abort, please",
				cut.signal,
			);
			first.catch(() => undefined);
			await provider.held("c0-t9", 5000);
			cut.abort();
			await expect(first, "the client went").rejects.toThrow();
			const again = await asking(provider.endpoint, "soak c0-t9 abort, please");
			expect(await again.text(), "asked again, answered at once").toContain(
				"heard, ack c0-t9.",
			);
		} finally {
			await provider.close();
		}
	});

	it("fails a wait on a held answer that never comes", async () => {
		const provider = await soakProvider();
		try {
			provider.hold("c0-t2");
			await expect(
				provider.held("c0-t2", 50),
				"no request came",
			).rejects.toThrow("c0-t2's held request didn't arrive in 50 ms");
		} finally {
			await provider.close();
		}
	});
});
