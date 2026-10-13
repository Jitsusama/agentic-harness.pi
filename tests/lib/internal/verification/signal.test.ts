import { afterEach, describe, expect, it } from "vitest";
import {
	currentVerificationFailure,
	provideVerificationCheck,
} from "../../../../lib/internal/verification/signal.ts";

afterEach(() => provideVerificationCheck(undefined));

describe("verification check", () => {
	it("finds nothing failing when nothing offers a check", async () => {
		expect(await currentVerificationFailure({ dir: "/repo" })).toBeUndefined();
	});

	it("asks the offered check each time, with the scope", async () => {
		const asked: Array<string | undefined> = [];
		let broken = true;
		provideVerificationCheck(async (scope) => {
			asked.push(scope.dir);
			return broken ? { problems: ["a.ts:1:0 broken"] } : undefined;
		});

		expect(await currentVerificationFailure({ dir: "/repo" })).toEqual({
			problems: ["a.ts:1:0 broken"],
		});
		broken = false;
		expect(await currentVerificationFailure({ dir: "/repo" })).toBeUndefined();
		expect(asked).toEqual(["/repo", "/repo"]);
	});
});
