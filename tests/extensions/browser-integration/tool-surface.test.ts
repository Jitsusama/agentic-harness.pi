import { describe, expect, it } from "vitest";
import {
	BROWSER_TOOLS,
	browserToolSurface,
	calledBrowserBefore,
	readsBrowserSkill,
} from "../../../extensions/browser-integration/tool-surface.js";

const REGISTERED = ["read", "bash", ...BROWSER_TOOLS];

describe("which browser tools a session carries", () => {
	it("carries none until browser work starts", () => {
		expect(browserToolSurface(REGISTERED, REGISTERED, false)).toEqual([
			"read",
			"bash",
		]);
	});

	it("carries all of them once it has", () => {
		const idle = browserToolSurface(REGISTERED, REGISTERED, false);
		expect(browserToolSurface(idle, REGISTERED, true)).toEqual(REGISTERED);
	});

	it("leaves every other tool as another extension set it", () => {
		expect(browserToolSurface(["bash"], REGISTERED, true)).toEqual([
			"bash",
			...BROWSER_TOOLS,
		]);
	});
});

describe("what counts as browser work starting", () => {
	it("counts reading either browser skill", () => {
		expect(
			readsBrowserSkill("read", { path: "/x/skills/browser-guide/SKILL.md" }),
		).toBe(true);
		expect(
			readsBrowserSkill("read", {
				path: "/x/skills/browser-accessibility-guide/SKILL.md",
			}),
		).toBe(true);
	});

	it("does not count reading anything else, or another tool", () => {
		expect(
			readsBrowserSkill("read", { path: "/x/skills/slack-guide/SKILL.md" }),
		).toBe(false);
		expect(
			readsBrowserSkill("bash", {
				command: "cat skills/browser-guide/SKILL.md",
			}),
		).toBe(false);
	});

	it("counts a session that already called a browser tool, so a reload mid-task keeps them", () => {
		expect(calledBrowserBefore(["read", "browser_go", "bash"])).toBe(true);
		expect(calledBrowserBefore(["read", "bash"])).toBe(false);
	});
});
