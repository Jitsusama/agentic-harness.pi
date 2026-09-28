/**
 * Every panel waits for the screen.
 *
 * Pi runs the tool calls of one assistant message concurrently, so two
 * `ask` calls, a guardian and a Google confirmation can all mount at
 * once. Pi's close pops the topmost overlay rather than its own, so the
 * first panel to close can take a different one down with it, and a gate
 * nobody saw is a gate that was never answered. Only Slack and review
 * queued, each by wrapping its own calls; the queue now sits at the
 * mount, where every caller goes through it.
 *
 * These drive the primitives with a fake `ctx.ui.custom` that records
 * each mount and settles when the test says, so the order is asserted
 * without booting a TUI.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { runGate } from "../../../lib/ui/gate-queue.ts";
import {
	promptSingle,
	promptTabbed,
	view,
	workspace,
} from "../../../lib/ui/panel.ts";
import { promptToggleList } from "../../../lib/ui/prompt-toggle-list.ts";
import type {
	SinglePromptConfig,
	TabbedPromptConfig,
	ViewConfig,
	WorkspacePromptConfig,
} from "../../../lib/ui/types.ts";

interface Screen {
	mounts: string[];
	status: Array<string | undefined>;
	close(answer?: unknown): void;
	ctx(name: string, signal?: AbortSignal): ExtensionContext;
}

/** A pretend screen: records each mount and closes the newest on request. */
function screen(): Screen {
	const open: Array<(answer: unknown) => void> = [];
	const mounts: string[] = [];
	const status: Array<string | undefined> = [];
	return {
		mounts,
		status,
		close(answer = null) {
			const settle = open.shift();
			if (!settle) throw new Error("nothing is on screen");
			settle(answer);
		},
		ctx(name, signal) {
			return {
				hasUI: true,
				signal,
				ui: {
					setStatus: (_key: string, text: string | undefined) => {
						status.push(text);
					},
					custom: () =>
						new Promise((resolve) => {
							mounts.push(name);
							open.push(resolve);
						}),
				},
			} as unknown as ExtensionContext;
		},
	};
}

async function drain(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

const SINGLE = {
	content: () => ["one line"],
	options: [{ label: "Yes", value: "yes" }],
} as unknown as SinglePromptConfig;

const TABBED = (n: number) =>
	({
		items: Array.from({ length: n }, (_, i) => ({
			label: `T${i}`,
			content: () => [`item ${i}`],
		})),
	}) as unknown as TabbedPromptConfig;

describe("two panels asked for at once", () => {
	it("mount one after the other, not both", async () => {
		const s = screen();
		const first = promptSingle(s.ctx("first"), SINGLE);
		const second = promptSingle(s.ctx("second"), SINGLE);
		await drain();
		expect(s.mounts).toEqual(["first"]);

		s.close();
		await first;
		await drain();
		expect(s.mounts).toEqual(["first", "second"]);
		s.close();
		await second;
	});

	it("wait for each other across every kind of panel", async () => {
		const others: Array<[string, (ctx: ExtensionContext) => Promise<unknown>]> =
			[
				["tabbed", (ctx) => promptTabbed(ctx, TABBED(2))],
				[
					"workspace",
					(ctx) =>
						workspace(ctx, {
							items: [],
							tabStatus: () => "pending",
							allComplete: () => false,
						} as unknown as WorkspacePromptConfig),
				],
				["view", (ctx) => view(ctx, { content: () => ["x"] } as ViewConfig)],
				[
					"toggle",
					(ctx) =>
						promptToggleList(ctx, {
							sections: [],
						} as unknown as Parameters<typeof promptToggleList>[1]),
				],
			];
		for (const [name, open] of others) {
			const s = screen();
			const holding = promptSingle(s.ctx("single"), SINGLE);
			const waiting = open(s.ctx(name));
			await drain();
			expect(s.mounts, name).toEqual(["single"]);
			s.close();
			await holding;
			await drain();
			expect(s.mounts, name).toEqual(["single", name]);
			s.close({});
			await waiting;
		}
	});

	it("leave the progress count to the panel on screen", async () => {
		// A queued tabbed gate that wrote its count straight away would
		// show a count for a panel nobody can see yet.
		const s = screen();
		const first = promptTabbed(s.ctx("first"), TABBED(2));
		await drain();
		const shown = s.status.length;
		const second = promptTabbed(s.ctx("second"), TABBED(5));
		await drain();
		expect(s.status.length).toBe(shown);

		s.close();
		await first;
		await drain();
		expect(s.mounts).toEqual(["first", "second"]);
		s.close();
		await second;
	});
});

describe("a panel whose turn is stopped while it waits", () => {
	it("never mounts, and answers as a cancel does", async () => {
		const s = screen();
		const holding = promptSingle(s.ctx("holding"), SINGLE);
		const controller = new AbortController();
		const waiting = promptSingle(s.ctx("waiting", controller.signal), SINGLE);
		await drain();
		controller.abort();

		expect(await waiting).toBeNull();
		s.close();
		await holding;
		await drain();
		expect(s.mounts).toEqual(["holding"]);
	});

	it("does not mount when its turn was already stopped", async () => {
		const s = screen();
		expect(
			await promptTabbed(s.ctx("late", AbortSignal.abort()), TABBED(2)),
		).toBeNull();
		await drain();
		expect(s.mounts).toEqual([]);
		expect(s.status).toEqual([]);
	});
});

describe("a view dismissed while it waits", () => {
	it("never mounts, where it would have stayed up for good", async () => {
		// Its dismiss listener is added as it mounts, and never hears an
		// abort that has already happened.
		const s = screen();
		const holding = promptSingle(s.ctx("holding"), SINGLE);
		const dismiss = new AbortController();
		const waiting = view(s.ctx("view"), {
			content: () => ["x"],
			signal: dismiss.signal,
		} as ViewConfig);
		await drain();
		dismiss.abort();
		await waiting;

		s.close();
		await holding;
		await drain();
		expect(s.mounts).toEqual(["holding"]);
	});
});

describe("a caller that already queued", () => {
	it("mounts its panel inside its own turn rather than behind it", async () => {
		// Slack and review wrap their prompts in the queue themselves.
		const s = screen();
		const wrapped = runGate(() => promptSingle(s.ctx("wrapped"), SINGLE));
		await drain();
		expect(s.mounts).toEqual(["wrapped"]);
		s.close();
		expect(await wrapped).toBeNull();
	});
});
