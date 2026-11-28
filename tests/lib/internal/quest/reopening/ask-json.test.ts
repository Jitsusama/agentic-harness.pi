import { afterEach, describe, expect, it, vi } from "vitest";
import { askJson } from "../../../../../lib/internal/quest/reopening/ask-json.ts";

/** What this process wrote to stderr while the test ran. */
function stderrWrites() {
	return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

describe("asking a program for JSON", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("answers a list past Node's 1 MB default, as mycelium's session list was", () => {
		const script = `process.stdout.write(JSON.stringify(Array.from({ length: 20000 }, (_, i) => ({ id: "s" + i, title: "x".repeat(90) }))))`;

		const answer = askJson(process.execPath, ["-e", script]);

		expect(answer).toHaveLength(20000);
		expect(JSON.stringify(answer).length).toBeGreaterThan(2_000_000);
		expect(answer).toContainEqual({ id: "s19999", title: "x".repeat(90) });
	});

	it("answers nothing and says nothing for a program that isn't there", () => {
		const writes = stderrWrites();

		const answer = askJson("no-such-program-1a20f3bd", ["sessions"]);

		expect(answer).toBeUndefined();
		expect(writes).not.toHaveBeenCalled();
	});

	it("answers nothing for output that isn't JSON, and says so naming the program", () => {
		const writes = stderrWrites();

		const answer = askJson(process.execPath, ["-e", `console.log("not json")`]);

		expect(answer).toBeUndefined();
		expect(writes).toHaveBeenCalledWith(
			expect.stringContaining(
				`${process.execPath} printed something that isn't JSON: `,
			),
		);
	});
});
