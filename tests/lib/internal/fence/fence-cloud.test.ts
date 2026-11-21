/**
 * How a fenced command is handed the agents' cloud account: the
 * broker's token, its project and the session's own settings folder,
 * set for the command alone and on no command line, in place of any
 * the person's shell names, run here through stand-ins for bubblewrap
 * and landrun.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fencedCommand } from "../../../../lib/internal/fence/fence-command.ts";
import {
	askTheCloudAhead,
	sandboxFor,
} from "../../../../lib/internal/sandbox/sandbox.ts";

const token = `ya29.${"a0B1-c2_D3".repeat(20)}`;

describe("a fenced command's cloud account", () => {
	let base: string;
	let skip: string;

	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), "fence-cloud-"));
		// Stands in for bubblewrap and landrun alike: drops their own
		// arguments and runs what follows the first `--`.
		skip = join(base, "skip");
		writeFileSync(
			skip,
			[
				"#!/usr/bin/env bash",
				'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done',
				'shift; exec "$@"',
			].join("\n"),
		);
		chmodSync(skip, 0o755);
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
			bwrap: skip,
			landrun: skip,
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

	it("shows on no command line inside", () => {
		const said = fenced('tr "\\0" " " < /proc/$$/cmdline; echo', {
			CLOUDSDK_AUTH_ACCESS_TOKEN: token,
		});
		expect(said).not.toContain(token);
	});

	it("passes nothing a variable's name can't be", () => {
		const text = fencedCommand("true", {
			bwrap: skip,
			landrun: skip,
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
		const found = (program: string) => `/run/current-system/sw/bin/${program}`;
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
