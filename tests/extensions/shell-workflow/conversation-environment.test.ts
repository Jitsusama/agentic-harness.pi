/**
 * The agent's commands start from their conversation's environment. On a
 * host the process's is nobody's, so only what pi changed of it carries
 * over; on plain pi the process's is the conversation's, left as pi made
 * it.
 */

import { delimiter } from "node:path";
import type { BashSpawnContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { fromConversation } from "../../../extensions/shell-workflow/environment.ts";
import { sessionEnv, withSession } from "../../../lib/core/session/index.ts";
import { installTestHost } from "../../support/session-host.ts";

const path = (...parts: string[]) => parts.join(delimiter);

/** The host process's environment, and what pi made of it for A. */
const PROCESS: NodeJS.ProcessEnv = {
	PATH: path("/usr/bin", "/bin"),
	HOST_ONLY: "the host's",
	PI_SESSION_ID: "host",
	PI_MODEL: "host-model",
};
const MADE: BashSpawnContext = {
	command: "true",
	cwd: "/work/a",
	env: {
		PATH: path("/pi/bin", "/usr/bin", "/bin"),
		HOST_ONLY: "the host's",
		PI_SESSION_ID: "conversation-a",
	},
};

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

describe("a command's environment on plain pi", () => {
	it("is what pi made of the process's", () => {
		expect(fromConversation(MADE, "a", PROCESS), "left as pi made it").toBe(
			MADE,
		);
	});
});

describe("a command's environment on a host", () => {
	function hosted() {
		const installed = installTestHost();
		dispose = installed.dispose;
		const a = sessionEnv("a");
		a.set("PATH", path("/home/a/bin", "/usr/bin"));
		a.set("TMPDIR", "/tmp/a");
		a.set("PI_MODEL", "a-model");
		sessionEnv("b").set("TMPDIR", "/tmp/b");
		return installed;
	}

	it("is its conversation's, with what pi changed and nothing else of the host's", () => {
		hosted();
		const env = fromConversation(MADE, "a", PROCESS).env;
		expect(env, "the conversation's, pi's changes on top").toEqual({
			PATH: path("/pi/bin", "/home/a/bin", "/usr/bin"),
			TMPDIR: "/tmp/a",
			PI_SESSION_ID: "conversation-a",
		});
		expect(
			withSession("b", () => fromConversation(MADE, undefined, PROCESS)).env
				.TMPDIR,
			"B's own, from where it is called",
		).toBe("/tmp/b");
	});

	it("keeps the conversation's PATH where pi changed the process's some other way", () => {
		hosted();
		const odd = { ...MADE, env: { ...MADE.env, PATH: "/elsewhere" } };
		expect(fromConversation(odd, "a", PROCESS).env.PATH).toBe(
			path("/home/a/bin", "/usr/bin"),
		);
	});
});
