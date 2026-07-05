import { describe, expect, it } from "vitest";
import {
	initialDocumentState,
	transition,
} from "../../../extensions/quest-workflow/machine";

describe("quest document machine", () => {
	it("starts idle", () => {
		expect(initialDocumentState()).toEqual({ stage: "idle" });
	});

	it("think requires a note", () => {
		const result = transition({ stage: "idle" }, { action: "think" });
		expect(result.ok).toBe(false);
	});

	it("think moves from idle to think", () => {
		const result = transition(
			{ stage: "idle" },
			{ action: "think", note: "investigate" },
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.state.stage).toBe("think");
	});

	it("think refuses when already thinking", () => {
		const result = transition(
			{ stage: "think" },
			{ action: "think", note: "again" },
		);
		expect(result.ok).toBe(false);
	});

	it("think refuses from a terminal stage", () => {
		for (const stage of ["concluded", "retired"] as const) {
			const result = transition({ stage }, { action: "think", note: "more" });
			expect(result.ok).toBe(false);
		}
	});

	it("draft only from think", () => {
		const fromIdle = transition({ stage: "idle" }, { action: "draft" });
		expect(fromIdle.ok).toBe(false);
		const fromThink = transition({ stage: "think" }, { action: "draft" });
		expect(fromThink.ok).toBe(true);
		if (fromThink.ok) expect(fromThink.state.stage).toBe("draft");
	});

	it("build only from draft", () => {
		const fromThink = transition({ stage: "think" }, { action: "build" });
		expect(fromThink.ok).toBe(false);
		const fromDraft = transition({ stage: "draft" }, { action: "build" });
		expect(fromDraft.ok).toBe(true);
		if (fromDraft.ok) expect(fromDraft.state.stage).toBe("build");
	});

	it("conclude from any active stage", () => {
		for (const stage of ["think", "draft", "build"] as const) {
			const result = transition({ stage }, { action: "conclude" });
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.state.stage).toBe("concluded");
		}
	});

	it("conclude refuses from idle or terminal stages", () => {
		for (const stage of ["idle", "concluded", "retired"] as const) {
			expect(transition({ stage }, { action: "conclude" }).ok).toBe(false);
		}
	});

	it("retire requires a reason", () => {
		expect(transition({ stage: "build" }, { action: "retire" }).ok).toBe(false);
		expect(
			transition({ stage: "build" }, { action: "retire", reason: "scope" }).ok,
		).toBe(true);
	});

	it("retire refuses from idle or terminal", () => {
		for (const stage of ["idle", "concluded", "retired"] as const) {
			expect(transition({ stage }, { action: "retire", reason: "x" }).ok).toBe(
				false,
			);
		}
	});
});
