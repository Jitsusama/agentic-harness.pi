/**
 * What the agent's commands run with: what other extensions offer, such
 * as the loaded quest's scratch, and never a prompt that waits for a
 * person.
 */

import { afterEach, describe, expect, it } from "vitest";
import { withoutInteraction } from "../../../extensions/shell-workflow/environment.ts";
import { offerShellEnvironment } from "../../../lib/internal/shell/environment.ts";

const spawn = (env: NodeJS.ProcessEnv = {}) =>
	withoutInteraction({ command: "true", cwd: "/", env }).env;

afterEach(() => {
	offerShellEnvironment("test", undefined);
	offerShellEnvironment("broken", undefined);
});

describe("the agent's shell environment", () => {
	it("asks for no credential on anyone's screen", () => {
		// An askpass window sat for 46 minutes overnight, holding a
		// release half-rolled, until somebody woke to dismiss it.
		expect(spawn({ SSH_ASKPASS: "/usr/bin/ssh-askpass" })).toMatchObject({
			GIT_ASKPASS: "",
			SSH_ASKPASS: "",
			SSH_ASKPASS_REQUIRE: "never",
			GIT_TERMINAL_PROMPT: "0",
		});
	});

	it("carries what another extension offers, asked as each command starts", () => {
		let dir = "/tmp/pi-QEST-A";
		offerShellEnvironment("test", () => ({ TMPDIR: dir }));

		expect(spawn().TMPDIR).toBe("/tmp/pi-QEST-A");
		dir = "/tmp/pi-QEST-B";
		expect(spawn().TMPDIR).toBe("/tmp/pi-QEST-B");
	});

	it("drops an offer once it is withdrawn", () => {
		offerShellEnvironment("test", () => ({ TMPDIR: "/tmp/pi-QEST-A" }));
		offerShellEnvironment("test", undefined);

		expect(spawn({ TMPDIR: "/tmp" }).TMPDIR).toBe("/tmp");
	});

	it("never lets an offer turn a prompt back on", () => {
		offerShellEnvironment("test", () => ({ GIT_ASKPASS: "/bin/askpass" }));

		expect(spawn().GIT_ASKPASS).toBe("");
	});

	it("runs the command without an offer that throws", () => {
		offerShellEnvironment("broken", () => {
			throw new Error("no state yet");
		});
		offerShellEnvironment("test", () => ({ TMPDIR: "/tmp/pi-QEST-A" }));

		expect(spawn().TMPDIR).toBe("/tmp/pi-QEST-A");
	});
});
