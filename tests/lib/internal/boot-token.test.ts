import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BOOT_TOKEN_AGAIN_MS,
	bootTokenReader,
	readBootToken,
} from "../../../lib/internal/boot-token.ts";

/** A reader over `answers`, read in turn, counting how often it is asked. */
function reading(answers: (string | undefined)[]) {
	let at = 0;
	let reads = 0;
	const clock = { now: 1000 };
	const token = bootTokenReader(
		() => {
			reads += 1;
			const answer = answers[Math.min(at, answers.length - 1)];
			at += 1;
			return answer;
		},
		() => clock.now,
	);
	return { token, clock, reads: () => reads };
}

describe("the boot token's reader", () => {
	it("reads a boot once and keeps its token for good", () => {
		// A boot's identifier can't change under the process reading it,
		// and each read can hold its caller for seconds on a busy Mac.
		const { token, clock, reads } = reading(["boot-1", "boot-2"]);
		expect(token()).toBe("boot-1");
		clock.now += BOOT_TOKEN_AGAIN_MS * 10;
		expect(token()).toBe("boot-1");
		expect(token()).toBe("boot-1");
		expect(reads(), "how often the boot was read").toBe(1);
	});

	it("leaves a boot it couldn't read until its wait has passed", () => {
		const { token, clock, reads } = reading([undefined, "boot-1"]);
		expect(token()).toBeUndefined();
		clock.now += BOOT_TOKEN_AGAIN_MS - 1;
		expect(token(), "asked again too soon").toBeUndefined();
		expect(reads(), "reads within the wait").toBe(1);
	});

	it("reads a boot it couldn't read again once its wait has passed", () => {
		// Once missed, never again would leave a session judging by the
		// clock alone until it restarts.
		const { token, clock, reads } = reading([undefined, "boot-1"]);
		expect(token()).toBeUndefined();
		clock.now += BOOT_TOKEN_AGAIN_MS;
		expect(token()).toBe("boot-1");
		expect(reads()).toBe(2);
	});

	it("waits again after each read that finds nothing", () => {
		const { token, clock, reads } = reading([undefined, undefined, "boot-1"]);
		token();
		clock.now += BOOT_TOKEN_AGAIN_MS;
		expect(token()).toBeUndefined();
		clock.now += BOOT_TOKEN_AGAIN_MS - 1;
		expect(token()).toBeUndefined();
		expect(reads(), "the second miss starts its own wait").toBe(2);
		clock.now += 1;
		expect(token()).toBe("boot-1");
	});
});

describe.skipIf(process.platform !== "darwin")("a Mac's boot token", () => {
	let bin: string;

	const sysctl = (script: string): string => {
		const file = join(bin, "sysctl");
		writeFileSync(file, `#!/bin/sh\n${script}\n`);
		chmodSync(file, 0o755);
		return file;
	};

	beforeEach(() => {
		bin = mkdtempSync(join(tmpdir(), "fake-sysctl-"));
	});

	afterEach(() => {
		rmSync(bin, { recursive: true, force: true });
	});

	it("reads as none when sysctl answers with nothing", () => {
		expect(readBootToken(sysctl("echo"))).toBeUndefined();
	});

	it("reads the uuid sysctl names, trimmed", () => {
		expect(readBootToken(sysctl("echo '  ABC-123  '"))).toBe("ABC-123");
	});

	it("reads as none when sysctl fails", () => {
		expect(readBootToken(sysctl("exit 1"))).toBeUndefined();
	});

	it("reads Apple's own sysctl, whatever PATH holds", () => {
		// Two sessions that read different programs would each give up the
		// other's running jobs as left by an earlier boot.
		const path = process.env.PATH;
		sysctl("echo from-path");
		process.env.PATH = `${bin}:${path ?? ""}`;
		try {
			expect(readBootToken()).not.toBe("from-path");
		} finally {
			process.env.PATH = path;
		}
	});
});
