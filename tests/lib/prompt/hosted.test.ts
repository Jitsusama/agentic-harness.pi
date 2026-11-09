/** Contributors stay with their conversation, including a fresh prompt after close. */
import { afterEach, describe, expect, it } from "vitest";
import {
	NoSessionInHost,
	withSession,
} from "../../../lib/core/session/index.ts";
import {
	clearPromptContributors,
	createFrozenResidentPrompt,
	registerPromptContributor,
	unregisterPromptContributor,
} from "../../../lib/prompt/index.ts";
import { installTestHost } from "../../support/session-host.ts";

const context = (id: string) =>
	({
		cwd: `/conversation/${id}`,
		sessionManager: { getSessionId: () => id },
	}) as never;
let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

describe("hosted prompt contributors", () => {
	it("keeps B's memory contributor when A's store closes", async () => {
		const installed = installTestHost();
		dispose = installed.dispose;
		let aOpen = true;
		withSession("a", () =>
			registerPromptContributor({
				id: "memory",
				order: 10,
				contribute: () => (aOpen ? "A facts" : undefined),
			}),
		);
		withSession("b", () =>
			registerPromptContributor({
				id: "memory",
				order: 10,
				contribute: () => "B facts",
			}),
		);
		expect(await createFrozenResidentPrompt().assemble(context("a"))).toBe(
			"A facts",
		);
		// Explicit assembly context wins even when dispatched in A.
		expect(
			await withSession("a", () =>
				createFrozenResidentPrompt().assemble(context("b")),
			),
		).toBe("B facts");
		aOpen = false;
		await installed.host.close("a", "store closed");
		// A fresh assembly, not just bytes frozen before A closed.
		expect(await createFrozenResidentPrompt().assemble(context("b"))).toBe(
			"B facts",
		);
	});

	it("clears and unregisters only the selected conversation", async () => {
		const installed = installTestHost();
		dispose = installed.dispose;
		for (const id of ["a", "b"])
			registerPromptContributor(
				{
					id: "same",
					order: 10,
					contribute: () => id,
				},
				id,
			);
		withSession("a", () => unregisterPromptContributor("same"));
		expect(await createFrozenResidentPrompt().assemble(context("b"))).toBe("b");
		registerPromptContributor(
			{ id: "same", order: 10, contribute: () => "a" },
			"a",
		);
		clearPromptContributors("a");
		expect(await createFrozenResidentPrompt().assemble(context("a"))).toBe("");
		expect(await createFrozenResidentPrompt().assemble(context("b"))).toBe("b");
	});

	it("refuses registration with no conversation", () => {
		const installed = installTestHost();
		dispose = installed.dispose;
		expect(() =>
			registerPromptContributor({
				id: "missing",
				order: 1,
				contribute: () => "wrong",
			}),
		).toThrow(NoSessionInHost);
	});
});
