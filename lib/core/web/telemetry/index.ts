/**
 * Telemetry: what the page did while nobody was looking.
 *
 * Buffers here are plain data structures over serializable
 * entries, so a record captured from CDP, from a fixture or
 * from another driver is read the same way.
 */

export {
	createRingBuffer,
	type Recorded,
} from "./buffer.ts";
export {
	type BrowserLogged,
	browserEntry,
	type ConsoleCalled,
	consoleEntry,
	exceptionEntry,
	type LogEntry,
} from "./console.ts";
export {
	answerFor,
	DEFAULT_DIALOG_POLICY,
	type DialogEvent,
	type DialogKind,
	type DialogPolicy,
	renderDialogs,
} from "./dialogs.ts";
export {
	createDownloadRecorder,
	type DownloadRecord,
	type DownloadState,
	renderDownloads,
} from "./downloads.ts";
export {
	diedWithTheTab,
	failureText,
	wasAborted,
} from "./failure.ts";
export { toHar } from "./har.ts";
export {
	createLifecycleRecorder,
	type LifecycleEvent,
	type LifecycleRecorder,
	strandedByCrash,
} from "./lifecycle.ts";
export {
	createNetworkRecorder,
	type NetworkRequest,
} from "./network.ts";
export {
	anyUrlShortened,
	renderRequests,
	requestStatus,
} from "./requests.ts";
export {
	foldSockets,
	renderSockets,
	type SocketEvent,
	type SocketRecord,
} from "./sockets.ts";
export { renderLogs } from "./view.ts";
