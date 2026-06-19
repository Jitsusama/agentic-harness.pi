import { describe, expect, it } from "vitest";
import { tokenize } from "../../../lib/command/index.js";

describe("tokenize", () => {
	it("yields no commands for an empty command", () => {
		const line = tokenize("");

		expect(line.source).toBe("");
		expect(line.commands).toEqual([]);
		expect(line.connectors).toEqual([]);
		expect(line.supported).toBe(true);
	});
});
