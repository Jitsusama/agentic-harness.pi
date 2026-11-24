/**
 * The priority workflow's guard on a search of the whole home folder:
 * refused with what to search instead, gone ahead when made again
 * unchanged, and waved through when the person turns it off.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { refuseHomeSearches } from "../../../extensions/priority-workflow/index.ts";
import {
	restoreSessionModes,
	setSessionMode,
} from "../../../lib/guardian/policy.ts";
import { GUARDS } from "../../../lib/internal/guardian/guards.ts";

type Verdict = { block?: boolean; reason?: string } | undefined;
type Handler = (event: unknown, ctx: { cwd: string }) => Promise<Verdict>;

function guard(): Handler {
	let handler: Handler | undefined;
	const pi = {
		on: (_name: string, fn: Handler) => {
			handler = fn;
		},
	} as unknown as Pick<ExtensionAPI, "on">;
	refuseHomeSearches(pi);
	if (!handler) throw new Error("no tool_call handler registered");
	return handler;
}

const bash = (command: string) => ({
	type: "tool_call",
	toolName: "bash",
	toolCallId: "t1",
	input: { command },
});

const IN_SRC = { cwd: join(homedir(), "src") };

beforeEach(() => restoreSessionModes({}));

describe("a search of the whole home folder", () => {
	it("is refused, saying to search a narrower folder", async () => {
		const verdict = await guard()(
			bash("find ~ -maxdepth 6 -path '*cadence*'"),
			IN_SRC,
		);
		expect(verdict).toMatchObject({ block: true });
		expect(verdict?.reason).toContain("narrower folder");
	});

	it("goes ahead when made again unchanged", async () => {
		const handler = guard();
		const command = bash("rg cadence ~");
		expect(await handler(command, IN_SRC)).toMatchObject({ block: true });
		expect(await handler(command, IN_SRC)).toBeUndefined();
	});

	it("goes ahead for a narrower folder", async () => {
		expect(
			await guard()(bash("rg cadence ~/src/core.nix"), IN_SRC),
		).toBeUndefined();
	});

	it("goes ahead when the person turns the guard off", async () => {
		setSessionMode(GUARDS.homeSearch.name, "off");
		expect(await guard()(bash("find ~ -name x"), IN_SRC)).toBeUndefined();
	});
});
