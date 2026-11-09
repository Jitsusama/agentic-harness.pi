/** Two real runners own separate result directories and shutdown lifetimes. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import resultStore from "../../../extensions/result-store-workflow/index.ts";
import { openSessionStore } from "../../../lib/core/result/location.ts";
import { extensionRunner } from "../../support/extension-runner.ts";

function writer(pi: ExtensionAPI) {
	resultStore(pi);
	pi.registerTool({
		name: "keep",
		label: "Keep",
		description: "Keep a test payload in the caller's store.",
		parameters: Type.Object({ value: Type.String() }),
		async execute(_id, params, _signal, _update, ctx) {
			const { handle } = openSessionStore(ctx).put(
				JSON.stringify({ value: params.value }),
			);
			return { content: [{ type: "text", text: handle }], details: {} };
		},
	});
}
const runners: ReturnType<typeof extensionRunner>[] = [];
afterEach(async () => {
	for (const runner of runners.splice(0)) await runner.stop();
});
function session() {
	const runner = extensionRunner(writer, process.cwd());
	runners.push(runner);
	return runner;
}
function text(
	answer: Awaited<ReturnType<ReturnType<typeof extensionRunner>["call"]>>,
) {
	return answer.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}
describe("session-owned result handles", () => {
	it("does not expose A's handle to B, and B quitting leaves A readable", async () => {
		const a = session();
		const b = session();
		await Promise.all([a.start(), b.start()]);
		const aHandle = text(await a.call("keep", { value: "Alice" }));
		const bHandle = text(await b.call("keep", { value: "Bob" }));
		const query = (runner: typeof a, handle: string) =>
			runner.call("result_query", { handle, expression: "$.value" });
		expect(text(await query(a, aHandle))).toContain("Alice");
		expect(text(await query(b, aHandle))).not.toContain("Alice");
		expect(text(await query(b, bHandle))).toContain("Bob");
		await b.stop();
		expect(text(await query(a, aHandle))).toContain("Alice");
		expect(text(await query(b, bHandle))).not.toContain("Bob");
		expect(a.errors).toEqual([]);
		expect(b.errors).toEqual([]);
	});

	it("stores identical content independently even when both handles match", async () => {
		const a = session();
		const b = session();
		await Promise.all([a.start(), b.start()]);
		const aHandle = text(await a.call("keep", { value: "shared text" }));
		const bHandle = text(await b.call("keep", { value: "shared text" }));
		expect(aHandle).toBe(bHandle);
		await b.stop();
		expect(
			text(
				await a.call("result_query", {
					handle: aHandle,
					expression: "$.value",
				}),
			),
		).toContain("shared text");
	});
});
