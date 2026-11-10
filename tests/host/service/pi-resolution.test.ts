/** The host program binds the harness's pi imports to the host's own pi, and nothing else. */
import { describe, expect, it } from "vitest";
import { piFromHost } from "../../../host/service/pi-resolution.ts";

const PI = "/nix/store/host-pi/lib/node_modules/pi-monorepo";
const HARNESS = "file:///harness/lib/core/viewer/terminal.ts";

interface Context {
	parentURL?: string;
	conditions?: string[];
}

/** What the hook passed on to node's own resolver. */
function resolved(specifier: string, parentURL: string) {
	const asks: { asked: string; context: Context | undefined }[] = [];
	piFromHost(PI)(
		specifier,
		{ parentURL, conditions: ["node"] },
		(asked: string, context?: Context) => {
			asks.push({ asked, context });
			return asked;
		},
	);
	expect(asks, "node is asked once").toHaveLength(1);
	const [ask] = asks;
	if (!ask) throw new Error("node was never asked");
	return { asked: ask.asked, context: ask.context ?? {} };
}

describe("piFromHost", () => {
	it("resolves a harness module's pi import from the host's pi, keeping the rest of the context", () => {
		for (const specifier of [
			"@earendil-works/pi-tui",
			"@earendil-works/pi-ai/compat",
		]) {
			const { asked, context } = resolved(specifier, HARNESS);
			expect(asked).toBe(specifier);
			expect(context).toEqual({
				parentURL: `file://${PI}/package.json`,
				conditions: ["node"],
			});
		}
	});

	it("leaves pi's own imports and every other package to node", () => {
		const own = `file://${PI}/packages/coding-agent/dist/index.js`;
		expect(resolved("@earendil-works/pi-ai", own).context.parentURL).toBe(own);
		for (const specifier of ["zod", "node:fs", "./terminal.ts"])
			expect(resolved(specifier, HARNESS).context.parentURL).toBe(HARNESS);
	});
});
