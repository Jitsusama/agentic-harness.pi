import { describe, expect, it } from "vitest";
import { waitedResults } from "../../../../lib/internal/priority/waited-results.ts";

describe("a background result the person waits on", () => {
	it("is owed when its report arrives after its job ended", () => {
		const results = waitedResults();
		results.called("call-1");

		expect(
			results.finished({ jobId: "j3", toolCallId: "call-1" }),
			"the job's end alone owes nothing yet",
		).toBe(false);
		expect(results.reported(["j3"]), "the report starts their run").toBe(true);
	});

	it("is owed when its job's end is heard after its report", () => {
		const results = waitedResults();
		results.called("call-1");

		expect(
			results.reported(["j3"]),
			"a report before its job's end owes nothing yet",
		).toBe(false);
		expect(
			results.finished({ jobId: "j3", toolCallId: "call-1" }),
			"the end arrives before the run starts",
		).toBe(true);
	});

	it("is not owed once the run its report started has begun", () => {
		const results = waitedResults();
		results.called("call-1");
		results.reported(["j3"]);
		results.began();

		expect(
			results.finished({ jobId: "j3", toolCallId: "call-1" }),
			"a run already begun is owed nothing more",
		).toBe(false);
	});

	it("is owed once, not again for a repeat of its report", () => {
		const results = waitedResults();
		results.called("call-1");
		results.finished({ jobId: "j3", toolCallId: "call-1" });
		results.reported(["j3"]);

		expect(
			results.reported(["j3"]),
			"a repeated report owes nothing again",
		).toBe(false);
	});
});

describe("a background result nobody waits on", () => {
	it("is not owed for a job a call outside a typed run started", () => {
		const results = waitedResults();
		results.finished({ jobId: "j3", toolCallId: "call-9" });

		expect(
			results.reported(["j3"]),
			"a call outside a typed run is owed nothing",
		).toBe(false);
	});

	it("is not owed for a job no call handed off", () => {
		const results = waitedResults();
		results.called("call-1");
		results.finished({ jobId: "j3" });

		expect(
			results.reported(["j3"]),
			"a job no call handed off is owed nothing",
		).toBe(false);
	});

	it("forgets the oldest calls past what it keeps", () => {
		const results = waitedResults(2);
		results.called("call-1");
		results.called("call-2");
		results.called("call-3");
		results.finished({ jobId: "j3", toolCallId: "call-1" });

		expect(
			results.reported(["j3"]),
			"a call past what it keeps is forgotten",
		).toBe(false);
	});
});
