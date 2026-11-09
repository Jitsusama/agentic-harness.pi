/** Git-state requests use each runner's folder, not the host's cwd. */
import { expect, it, vi } from "vitest";
import statusLine from "../../../extensions/status-line-widget/index.ts";
import { extensionRunner } from "../../support/extension-runner.ts";

const asks = vi.hoisted(() => vi.fn());
vi.mock("../../../extensions/status-line-widget/git.ts", () => ({
	Engine: class {
		ask = asks;
		stop() {}
	},
}));
vi.mock(
	"../../../extensions/status-line-widget/where.ts",
	async (original) => ({
		...(await original<object>()),
		readWhere: () => ({ engine: "fake", roots: [], marks: {} }),
	}),
);
it("asks about A and B independently on start and on shell completion", async () => {
	const a = extensionRunner(statusLine, "/work/a"),
		b = extensionRunner(statusLine, "/work/b");
	try {
		await a.start();
		await b.start();
		expect(asks.mock.calls).toEqual([["/work/a"], ["/work/b"]]);
		await a.runner.emitUserBash({
			type: "user_bash",
			command: "true",
			cwd: "/work/a",
			excludeFromContext: false,
		});
		expect(asks).toHaveBeenLastCalledWith("/work/a");
		expect(a.errors).toEqual([]);
		expect(b.errors).toEqual([]);
	} finally {
		await a.stop();
		await b.stop();
		asks.mockClear();
	}
});
