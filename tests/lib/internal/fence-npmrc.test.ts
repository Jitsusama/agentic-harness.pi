/**
 * The copy of the person's npm settings the fence binds over them: every
 * line but a registry token's, and the copy made only when there is a
 * token to hold back.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	fenceNpmrc,
	withoutNpmTokens,
} from "../../../lib/internal/fence-npmrc.ts";

/** Stand-ins for tokens, never real ones. */
const SETTINGS = [
	"@shopify:registry=https://npm.example/node/",
	"//npm.example/node/:_authToken=not-a-token",
	"//proxy.example/:tokenHelper=/home/someone/bin/proxy-token",
	"_auth=bm90LWEtdG9rZW4=",
	"//other.example/:_password=bm90LWEtcGFzc3dvcmQ=",
	"  _authToken = not-a-token-either",
	"cafile=/etc/ssl/certs/ca.pem",
	"; a comment naming _authToken in passing",
].join("\n");

describe("npm's settings without their tokens", () => {
	it("replaces each token's line with one naming its setting, and keeps every other line", () => {
		expect(withoutNpmTokens(SETTINGS)?.split("\n")).toEqual([
			"@shopify:registry=https://npm.example/node/",
			"; //npm.example/node/:_authToken is held back by the agent fence",
			"//proxy.example/:tokenHelper=/home/someone/bin/proxy-token",
			"; _auth is held back by the agent fence",
			"; //other.example/:_password is held back by the agent fence",
			"; _authToken is held back by the agent fence",
			"cafile=/etc/ssl/certs/ca.pem",
			"; a comment naming _authToken in passing",
		]);
	});

	it("never keeps a token's value", () => {
		const copy = withoutNpmTokens(SETTINGS) ?? "";
		for (const value of [
			"not-a-token",
			"bm90LWEtdG9rZW4=",
			"bm90LWEtcGFzc3dvcmQ=",
		]) {
			expect(copy).not.toContain(value);
		}
	});

	it("is nothing when the settings hold no token", () => {
		expect(
			withoutNpmTokens("registry=https://npm.example/\n; _authToken=x"),
		).toBe(undefined);
	});
});

describe("the copy the fence binds", () => {
	const runtimeDir = mkdtempSync(join(tmpdir(), "fence-npmrc-"));
	afterAll(() => rmSync(runtimeDir, { recursive: true, force: true }));
	const home = "/home/someone";
	/** The person's settings holding `text`, and the disk for the rest. */
	const settingsOf =
		(text: string | undefined) =>
		(path: string): string | undefined => {
			if (path === join(home, ".npmrc")) return text;
			try {
				return readFileSync(path, "utf8");
			} catch {
				// Not written yet.
				return undefined;
			}
		};

	it("is written in pi's folder in the runtime folder, for the person alone", () => {
		const path = fenceNpmrc(home, runtimeDir, settingsOf(SETTINGS));
		expect(path).toBe(join(runtimeDir, "pi-fence", "npmrc"));
		expect(readFileSync(path ?? "", "utf8")).toBe(withoutNpmTokens(SETTINGS));
		expect(statSync(path ?? "").mode & 0o777, "only the person reads it").toBe(
			0o600,
		);
		expect(
			fenceNpmrc(home, runtimeDir, settingsOf(SETTINGS)),
			"made once, then kept",
		).toBe(path);
	});

	it("is nothing where the settings hold no token or aren't there", () => {
		expect(
			fenceNpmrc(home, runtimeDir, settingsOf("registry=https://npm.example/")),
		).toBe(undefined);
		expect(fenceNpmrc(home, runtimeDir, settingsOf(undefined))).toBe(undefined);
	});

	it("is /dev/null where a token needs holding back but no copy can be written", () => {
		expect(fenceNpmrc(home, undefined, settingsOf(SETTINGS))).toBe("/dev/null");
		expect(
			fenceNpmrc(home, "/proc/no-such-runtime", settingsOf(SETTINGS)),
		).toBe("/dev/null");
	});
});
