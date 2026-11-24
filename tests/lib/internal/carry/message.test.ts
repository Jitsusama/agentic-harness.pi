/**
 * What carrying says of something thrown: its message where it is an
 * error, itself where it isn't, and never a throw of its own, however
 * what was thrown is made.
 */

import { describe, expect, it } from "vitest";
import { messageOf } from "../../../../lib/internal/carry/message.ts";

describe("saying what was thrown", () => {
	it("says an error's message", () => {
		expect(messageOf(new Error("database is locked"))).toBe(
			"database is locked",
		);
	});

	it("says where what was thrown said nothing, as a bare error does", () => {
		// As `new Error()` makes it, which the linter won't let be written.
		const bare = Object.assign(new Error("said"), { message: "" });
		expect(messageOf(bare)).toBe(
			"something was thrown that said nothing of why",
		);
		expect(messageOf("")).toBe("something was thrown that said nothing of why");
	});

	it("says a thrown value that isn't an error as itself", () => {
		expect(messageOf("no space left")).toBe("no space left");
		expect(messageOf(7)).toBe("7");
	});

	it.each([
		["has no prototype, so no toString", () => Object.create(null)],
		[
			"has a toString that throws",
			() => ({
				toString() {
					throw new Error("can't say");
				},
			}),
		],
		[
			"is an error whose message can't be read",
			() => {
				const error = new Error("hidden");
				Object.defineProperty(error, "message", {
					get() {
						throw new Error("can't read");
					},
				});
				return error;
			},
		],
		[
			"is a proxy that throws on every ask",
			() =>
				new Proxy(
					{},
					{
						get() {
							throw new Error("no");
						},
						getPrototypeOf() {
							throw new Error("no");
						},
					},
				),
		],
	])("never throws for a value that %s", (_, made) => {
		const thrown: unknown = made();

		expect(() => messageOf(thrown)).not.toThrow();
		expect(messageOf(thrown), "it still says something").toMatch(/\S/);
	});
});
