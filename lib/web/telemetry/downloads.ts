/**
 * Files the page handed back.
 *
 * A download is the one result that never appears in the page,
 * so without capturing it there is no way to check that an
 * export button produced the right csv, or produced anything
 * at all.
 */

/** Where a download got to. */
export type DownloadState = "inProgress" | "completed" | "canceled";

/** One file, from the moment the browser knew about it. */
export interface DownloadRecord {
	readonly guid: string;
	readonly url: string;
	readonly suggestedFilename: string;
	readonly state: DownloadState;
	readonly totalBytes?: number;
	readonly receivedBytes?: number;
	readonly filePath?: string;
}

/** The protocol events this fold consumes. */
export type DownloadInput =
	| {
			readonly kind: "begin";
			readonly guid: string;
			readonly url: string;
			readonly suggestedFilename: string;
	  }
	| {
			readonly kind: "progress";
			readonly guid: string;
			readonly state: DownloadState;
			readonly totalBytes?: number;
			readonly receivedBytes?: number;
			readonly filePath?: string;
	  };

/** A running record of every file the page produced. */
export interface DownloadRecorder {
	apply(input: DownloadInput): void;
	all(): readonly DownloadRecord[];
}

export function createDownloadRecorder(): DownloadRecorder {
	const byGuid = new Map<string, DownloadRecord>();

	return {
		apply(input) {
			if (input.kind === "begin") {
				byGuid.set(input.guid, {
					guid: input.guid,
					url: input.url,
					suggestedFilename: input.suggestedFilename,
					state: "inProgress",
				});
				return;
			}

			const existing = byGuid.get(input.guid);
			// Progress for a download that began before capture was on
			// has no name or source, and a record without those says
			// nothing worth saying.
			if (!existing) return;

			byGuid.set(input.guid, {
				...existing,
				state: input.state,
				...(input.totalBytes === undefined
					? {}
					: { totalBytes: input.totalBytes }),
				// A cancelled download reports zero received, which would
				// otherwise overwrite the progress it really made.
				...(input.receivedBytes === undefined || input.state === "canceled"
					? {}
					: { receivedBytes: input.receivedBytes }),
				...(input.filePath === undefined ? {} : { filePath: input.filePath }),
			});
		},
		all() {
			return [...byGuid.values()];
		},
	};
}

/** What the page has handed back. */
export function renderDownloads(downloads: readonly DownloadRecord[]): string {
	if (downloads.length === 0) return "The page has not downloaded anything.";

	return downloads
		.map((download) => {
			const size =
				download.totalBytes === undefined
					? ""
					: ` (${download.totalBytes} bytes)`;
			if (download.state === "completed") {
				return `${download.suggestedFilename}${size}\n  ${
					download.filePath ?? "written, but the path was not reported"
				}`;
			}
			if (download.state === "canceled") {
				return `${download.suggestedFilename}: cancelled before it finished`;
			}
			return `${download.suggestedFilename}: still arriving${size}`;
		})
		.join("\n");
}
