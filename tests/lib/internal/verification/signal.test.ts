import { afterEach, describe, expect, it } from "vitest";
import {
	isVerificationFailing,
	setVerificationFailing,
} from "../../../../lib/internal/verification/signal.js";

afterEach(() => setVerificationFailing(false));

describe("verification signal", () => {
	it("defaults to not failing", () => {
		expect(isVerificationFailing()).toBe(false);
	});

	it("reflects the last set value", () => {
		setVerificationFailing(true);
		expect(isVerificationFailing()).toBe(true);
		setVerificationFailing(false);
		expect(isVerificationFailing()).toBe(false);
	});
});
