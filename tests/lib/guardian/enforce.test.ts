import { describe, expect, it } from "vitest";
import { blockIfUnsupported } from "../../../lib/guardian/enforce.js";

describe("blockIfUnsupported", () => {
	it("allows a command in a supported shape", () => {
		expect(blockIfUnsupported("git commit -m x")).toBeUndefined();
	});

	it("blocks a command wrapped in command substitution", () => {
		const result = blockIfUnsupported("x=$(git commit -m x)");

		expect(result).toBeDefined();
		expect(result && "block" in result && result.block).toBe(true);
		expect(result && "reason" in result && result.reason).toMatch(
			/substitution|simple form|shape/i,
		);
	});
});
