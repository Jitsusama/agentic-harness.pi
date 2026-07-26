/**
 * Downloads. The event shapes are from a live session,
 * including the detail that a cancelled download reports zero
 * received bytes after having reported the real figure.
 */

import { describe, expect, it } from "vitest";
import {
	createDownloadRecorder,
	renderDownloads,
} from "../../../../lib/web/telemetry/downloads.js";

const begin = {
	kind: "begin",
	guid: "G1",
	url: "http://localhost:8731/report.csv",
	suggestedFilename: "report.csv",
} as const;

describe("createDownloadRecorder", () => {
	it("starts with nothing", () => {
		expect(createDownloadRecorder().all()).toEqual([]);
	});

	it("records a download from the moment the browser knows of it", () => {
		const log = createDownloadRecorder();
		log.apply(begin);
		const [record] = log.all();
		expect(record?.suggestedFilename).toBe("report.csv");
		expect(record?.state).toBe("inProgress");
	});

	it("follows it to completion and keeps where it landed", () => {
		const log = createDownloadRecorder();
		log.apply(begin);
		log.apply({
			kind: "progress",
			guid: "G1",
			state: "completed",
			totalBytes: 18,
			receivedBytes: 18,
			filePath: "/tmp/dl/report.csv",
		});
		const [record] = log.all();
		expect(record?.state).toBe("completed");
		expect(record?.filePath).toBe("/tmp/dl/report.csv");
		expect(record?.receivedBytes).toBe(18);
	});

	it("keeps the progress a cancelled download really made", () => {
		// Chrome reports receivedBytes back at zero when it cancels,
		// which would erase the figure it gave a moment earlier.
		const log = createDownloadRecorder();
		log.apply(begin);
		log.apply({
			kind: "progress",
			guid: "G1",
			state: "inProgress",
			totalBytes: 18,
			receivedBytes: 12,
		});
		log.apply({
			kind: "progress",
			guid: "G1",
			state: "canceled",
			totalBytes: 18,
			receivedBytes: 0,
		});
		const [record] = log.all();
		expect(record?.state).toBe("canceled");
		expect(record?.receivedBytes).toBe(12);
	});

	it("ignores progress for a download it never saw start", () => {
		const log = createDownloadRecorder();
		log.apply({ kind: "progress", guid: "GHOST", state: "completed" });
		expect(log.all()).toEqual([]);
	});

	it("keeps one record per file, not one per event", () => {
		const log = createDownloadRecorder();
		log.apply(begin);
		for (const receivedBytes of [4, 8, 12, 18]) {
			log.apply({
				kind: "progress",
				guid: "G1",
				state: "inProgress",
				receivedBytes,
			});
		}
		expect(log.all()).toHaveLength(1);
	});
});

describe("renderDownloads", () => {
	it("says none rather than printing an empty list", () => {
		expect(renderDownloads([])).toBe("The page has not downloaded anything.");
	});

	it("gives the path of a finished file, which is the point", () => {
		const out = renderDownloads([
			{
				guid: "G1",
				url: "http://a/report.csv",
				suggestedFilename: "report.csv",
				state: "completed",
				totalBytes: 18,
				filePath: "/tmp/dl/report.csv",
			},
		]);
		expect(out).toContain("report.csv");
		expect(out).toContain("/tmp/dl/report.csv");
		expect(out).toContain("18 bytes");
	});

	it("says plainly when one was cancelled", () => {
		expect(
			renderDownloads([
				{
					guid: "G1",
					url: "http://a/x.csv",
					suggestedFilename: "x.csv",
					state: "canceled",
				},
			]),
		).toContain("cancelled");
	});

	it("admits when a finished file did not report where it went", () => {
		const out = renderDownloads([
			{
				guid: "G1",
				url: "http://a/x.csv",
				suggestedFilename: "x.csv",
				state: "completed",
			},
		]);
		expect(out).toContain("path was not reported");
	});
});
