import { describe, expect, it } from "vitest";
import { runProseGate } from "../../../../lib/internal/guardian/prose-gate.js";

function deps(initial: string[] = []) {
	const signatures = [...initial];
	return {
		signatures,
		readSignatures: () => signatures,
		persistSignature: (sig: string) => {
			signatures.push(sig);
		},
	};
}

describe("runProseGate", () => {
	it("allows a clean body", () => {
		const d = deps();
		expect(runProseGate(d, "All clean Canadian prose.")).toBeUndefined();
		expect(d.signatures).toEqual([]);
	});

	it("allows an empty body", () => {
		expect(runProseGate(deps(), null)).toBeUndefined();
	});

	it("blocks a first violation and records its signature", () => {
		const d = deps();
		const result = runProseGate(d, "Pick a color.");
		expect(result).toBeDefined();
		expect(result && "block" in result && result.block).toBe(true);
		expect(d.signatures).toHaveLength(1);
	});

	it("relents to the human gate when the same violation was already blocked", () => {
		const d = deps();
		const first = runProseGate(d, "Pick a color."); // first: blocks, records
		expect(first && "block" in first && first.block).toBe(true);
		// Same violation again: do not block the AI in a loop. Fall
		// through to the human review gate (undefined) so the user is
		// the safety net, and do not record a duplicate signature.
		const second = runProseGate(d, "Pick a color.");
		expect(second).toBeUndefined();
		expect(d.signatures).toHaveLength(1);
	});

	it("blocks again when the violation set changed", () => {
		const d = deps();
		runProseGate(d, "Pick a color.");
		const second = runProseGate(d, "Pick a behavior.");
		expect(second && "block" in second && second.block).toBe(true);
		expect(d.signatures).toHaveLength(2);
	});
});
