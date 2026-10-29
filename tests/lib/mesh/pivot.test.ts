/**
 * A pivot: sent only by an orchestrator, only within its orchestration,
 * and heeded at once only from the receiver's own orchestrator.
 */
import { describe, expect, it } from "vitest";
import { attend, type Standing } from "../../../lib/mesh/attention.ts";
import type { Message } from "../../../lib/mesh/message.ts";
import { pivotTargets } from "../../../lib/mesh/pivot.ts";

const present = [
	{ addresses: ["QCXZEB", "7F725450"], orchestratedBy: "WCJQSG" },
	{ addresses: ["85PKB2"], orchestratedBy: "WCJQSG" },
	{ addresses: ["N10TYF"] },
];

describe("where a pivot may go", () => {
	it("goes to the orchestration when it names nowhere", () => {
		expect(pivotTargets("WCJQSG", [], present)).toEqual({
			to: ["#orchestration/wcjqsg"],
		});
	});

	it("goes to the sessions it orchestrates, by any of their addresses", () => {
		expect(pivotTargets("WCJQSG", ["@7F725450", "@85PKB2"], present)).toEqual({
			to: ["@7F725450", "@85PKB2"],
		});
	});

	it("is refused to a session outside the orchestration, naming it", () => {
		const sent = pivotTargets("WCJQSG", ["@QCXZEB", "@N10TYF"], present);
		expect(sent).toHaveProperty("refused");
		expect("refused" in sent && sent.refused).toContain("@N10TYF is outside");
	});

	it("names the orchestrator to ask when the session is in another's orchestration", () => {
		// Four orchestrators share optimus; one turns another's sessions
		// only through it, as equals.
		const machine = [
			...present,
			{ addresses: ["WJATIN"], orchestrates: "WJATIN" },
			{ addresses: ["19AMVE"], orchestratedBy: "WJATIN" },
			{ addresses: ["OA9O3L"], orchestratedBy: "GONEAA" },
		];
		const refusal = (to: string) => {
			const sent = pivotTargets("WCJQSG", [to], machine);
			return "refused" in sent ? sent.refused : "";
		};

		expect(refusal("@19AMVE")).toContain(
			"@19AMVE is in WJATIN's orchestration; send it to WJATIN as a question",
		);
		expect(refusal("@WJATIN")).toContain(
			"@WJATIN is an orchestrator; ask it with a question",
		);
		expect(refusal("@OA9O3L")).toContain(
			"send it to #orchestration/goneaa as a question",
		);
		expect(refusal("@N10TYF")).not.toContain("as a question");
	});

	it("is refused to the whole machine", () => {
		expect(pivotTargets("WCJQSG", ["#machine"], present)).toHaveProperty(
			"refused",
		);
	});

	it("is refused from a session playing no orchestrator's role", () => {
		const sent = pivotTargets(undefined, ["@85PKB2"], present);
		expect("refused" in sent && sent.refused).toContain("only an orchestrator");
	});
});

describe("the attention a pivot gets", () => {
	const pivot: Message = {
		v: 1,
		id: "1-WCJQSG-1-aaaa",
		at: "2026-10-26T05:50:00.000Z",
		from: "WCJQSG",
		to: ["#orchestration/wcjqsg"],
		text: "Drop the timer work; the backups come first.",
		intent: "pivot",
		pid: 1,
	};
	const busy: Standing = {
		receiver: { addresses: ["QCXZEB"], worksOn: "Agentic loop", owns: [] },
		idle: false,
		orchestrator: ["WCJQSG", "P9R1KI"],
	};

	it("starts a turn, steered into a busy run, from its own orchestrator", () => {
		expect(attend(pivot, busy)).toMatchObject({
			attention: "turn",
			addressed: true,
		});
	});

	it("is its orchestrator's under any address that session signs with", () => {
		expect(attend({ ...pivot, from: "P9R1KI" }, busy).attention).toBe("turn");
	});

	it("is only noted from another orchestrator, judged however it is", () => {
		const other = {
			...busy,
			orchestrator: ["Y9XISP"],
			concern: "other" as const,
		};
		expect(attend(pivot, other).attention).toBe("note");
	});
});
