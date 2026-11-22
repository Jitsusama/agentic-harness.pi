/**
 * How a fenced command is handed the agents' cloud account: the
 * broker's token, its project and the session's own settings folder,
 * set for the command alone and on neither bubblewrap's nor landrun's
 * command line, in place of any cloud variable the person's shell names,
 * run here through stand-ins for bubblewrap and landrun that write down
 * what they were told.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	fencedCommand,
	isHandedName,
} from "../../../../lib/internal/fence/fence-command.ts";
import { fenceFolders } from "../../../../lib/internal/fence/fence-home.ts";
import {
	askTheCloudAhead,
	fenceCloud,
	sandboxFor,
	withoutCloud,
} from "../../../../lib/internal/sandbox/sandbox.ts";
import { sandboxFolders } from "../../../../lib/internal/sandbox/strict-rules.ts";

const token = `ya29.${"a0B1-c2_D3".repeat(20)}`;

describe("a fenced command's cloud account", () => {
	let base: string;
	let bwrap: string;
	let landrun: string;

	/** A stand-in that writes its arguments to `said`, then runs what follows the first `--`. */
	function standIn(name: string): string {
		const path = join(base, name);
		writeFileSync(
			path,
			[
				"#!/usr/bin/env bash",
				`printf '%s\\n' "$@" > ${join(base, `${name}.said`)}`,
				'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done',
				'shift; exec "$@"',
			].join("\n"),
		);
		chmodSync(path, 0o755);
		return path;
	}

	/** What the stand-in `name` was told, a word a line. */
	function told(name: string): string[] {
		return readFileSync(join(base, `${name}.said`), "utf8").split("\n");
	}

	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), "fence-cloud-"));
		bwrap = standIn("bwrap");
		landrun = standIn("landrun");
	});

	afterAll(() => {
		rmSync(base, { recursive: true, force: true });
	});

	/** What `script` prints run as a fenced command handed `passed`, in a shell exporting `outside`. */
	function fenced(
		script: string,
		passed: Record<string, string>,
		outside: Record<string, string> = {},
	): string {
		const text = fencedCommand(script, {
			bwrap,
			landrun,
			args: [],
			rules: [],
			passed,
		});
		const ran = spawnSync("bash", ["-c", text], {
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "", ...outside },
		});
		expect(ran.status, ran.stderr).toBe(0);
		return ran.stdout;
	}

	it("reaches the command, in place of the settings folder the person's shell names", () => {
		const said = fenced(
			'echo "$CLOUDSDK_AUTH_ACCESS_TOKEN $CLOUDSDK_CORE_PROJECT $CLOUDSDK_CONFIG"',
			{
				CLOUDSDK_AUTH_ACCESS_TOKEN: token,
				CLOUDSDK_CORE_PROJECT: "a-lab-project",
				CLOUDSDK_CONFIG: "/sandbox/gcloud/s-1",
			},
			{ CLOUDSDK_CONFIG: "/home/someone/.config/gcloud" },
		);
		expect(said.trim()).toBe(`${token} a-lab-project /sandbox/gcloud/s-1`);
	});

	it("is named to landrun and given on neither bubblewrap's nor landrun's command line", () => {
		fenced("true", {
			CLOUDSDK_AUTH_ACCESS_TOKEN: token,
			CLOUDSDK_CORE_PROJECT: "a-lab-project",
		});
		for (const name of ["bwrap", "landrun"]) {
			expect(told(name).join(" "), `${name}'s arguments`).not.toContain(token);
		}
		const words = told("landrun");
		for (const name of [
			"CLOUDSDK_AUTH_ACCESS_TOKEN",
			"CLOUDSDK_CORE_PROJECT",
		]) {
			const at = words.indexOf(name);
			expect(at, `landrun was told ${name}`).toBeGreaterThan(0);
			expect(words[at - 1]).toBe("--env");
		}
	});

	it("lets none of the person's own cloud variables in, with a grant or without", () => {
		const persons = {
			CLOUDSDK_AUTH_ACCESS_TOKEN: "persons-token",
			CLOUDSDK_API_ENDPOINT_OVERRIDES_COMPUTE: "https://elsewhere.example/",
			GOOGLE_APPLICATION_CREDENTIALS: "/home/someone/key.json",
		};
		const script =
			// biome-ignore lint/suspicious/noTemplateCurlyInString: bash expands it, not JavaScript.
			'echo "${CLOUDSDK_AUTH_ACCESS_TOKEN-none} ${CLOUDSDK_API_ENDPOINT_OVERRIDES_COMPUTE-none} ${GOOGLE_APPLICATION_CREDENTIALS-none}"';
		expect(fenced(script, {}, persons).trim()).toBe("none none none");
		expect(
			fenced(script, { CLOUDSDK_AUTH_ACCESS_TOKEN: token }, persons).trim(),
		).toBe(`${token} none none`);
	});

	it("passes only names a variable can take", () => {
		for (const name of ["CLOUDSDK_CONFIG", "_A", "A1"]) {
			expect(isHandedName(name), name).toBe(true);
		}
		for (const name of ["", "a", "1A", "A=B", "A B", "A;B", "A$B"]) {
			expect(isHandedName(name), name).toBe(false);
		}
		const text = fencedCommand("true", {
			bwrap,
			landrun,
			args: [],
			rules: [],
			passed: { "A;touch /tmp/x": "value" },
		});
		expect(text).not.toContain("touch /tmp/x");
	});

	it("is asked for ahead of the first command in the agent fence as in strict", () => {
		const asked: string[] = [];
		const gcloud = () => {
			asked.push("asked");
			return { reason: "still minting" };
		};
		// No nix-offload is found, so nothing outside the test is started.
		const found = (program: string) =>
			program === "nix-offload" || program === "env"
				? undefined
				: `/run/current-system/sw/bin/${program}`;
		const fence = sandboxFor(
			{ PI_SANDBOX: "fence" },
			"linux",
			found,
			() => undefined,
			gcloud,
			() => false,
		);
		expect(fence.kind).toBe("fence");
		askTheCloudAhead(fence);
		expect(asked).toEqual(["asked"]);
	});
});

describe("what the agent fence hands gcloud", () => {
	let home: string;

	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), "fence-cloud-home-"));
	});

	afterAll(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("is the broker's token and project, with a settings folder of the session's own in the fence's place", () => {
		const { grant, passed } = fenceCloud(
			{ gcloud: () => ({ token, project: "a-lab-project" }) },
			home,
			{ PI_SESSION_ID: "s-1" },
		);
		const settings = join(fenceFolders(home).gcloud, "s-1");
		expect(grant).toEqual({ token, project: "a-lab-project" });
		expect(passed).toEqual({
			CLOUDSDK_AUTH_ACCESS_TOKEN: token,
			CLOUDSDK_CORE_PROJECT: "a-lab-project",
			CLOUDSDK_CONFIG: settings,
		});
		expect(statSync(settings).mode & 0o777).toBe(0o700);
	});

	it("is only the empty settings folder when the broker gave nothing, with why for the note", () => {
		const { grant, passed } = fenceCloud(
			{ gcloud: () => ({ reason: "gcloud-broker isn't on this machine" }) },
			home,
			{ PI_SESSION_ID: "s-2" },
		);
		expect(grant).toEqual({ reason: "gcloud-broker isn't on this machine" });
		expect(passed).toEqual({
			CLOUDSDK_CONFIG: join(fenceFolders(home).gcloud, "s-2"),
		});
	});

	it("is nothing at all for a run with no broker to ask, which mints nothing and makes no folder", () => {
		let asked = 0;
		const fence = withoutCloud({
			kind: "fence",
			bwrap: "/bin/bwrap",
			landrun: "/bin/landrun",
			gcloud: () => {
				asked += 1;
				return { token, project: "a-lab-project" };
			},
		});
		if (fence.kind !== "fence") throw new Error("no longer the fence");
		expect("gcloud" in fence).toBe(false);
		expect(fenceCloud(fence, home, { PI_SESSION_ID: "s-3" })).toEqual({});
		askTheCloudAhead(fence);
		expect(asked).toBe(0);
		expect(existsSync(join(fenceFolders(home).gcloud, "s-3"))).toBe(false);
	});

	it("keeps its folders where no strict command can write", () => {
		const fence = Object.values(fenceFolders(home));
		for (const strict of Object.values(sandboxFolders(home))) {
			for (const own of fence) {
				expect(
					own === strict || own.startsWith(`${strict}/`),
					`${own} lies in strict's ${strict}`,
				).toBe(false);
			}
		}
	});
});
