/**
 * Telemetry: what the page did while nobody was looking.
 *
 * Buffers here are plain data structures over serializable
 * entries, so a record captured from CDP, from a fixture or
 * from another driver is read the same way.
 */

export {
	type BufferLimits,
	createRingBuffer,
	type Recorded,
	type RingBuffer,
} from "./buffer.ts";
export {
	type BrowserLogged,
	browserEntry,
	type CallFrame,
	type ConsoleCalled,
	consoleEntry,
	consoleText,
	type ExceptionThrown,
	exceptionEntry,
	type LogEntry,
	type RemoteArg,
	type RemotePreview,
	type RemotePreviewProperty,
	renderArg,
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
	type DownloadInput,
	type DownloadRecord,
	type DownloadRecorder,
	type DownloadState,
	renderDownloads,
} from "./downloads.ts";
export { diedWithTheTab, failureText } from "./failure.ts";
export {
	type Har,
	type HarEntry,
	type HarOptions,
	type HarPair,
	type HarTimings,
	toHar,
} from "./har.ts";
export {
	createLifecycleRecorder,
	type LifecycleEvent,
	type LifecycleInput,
	type LifecycleKind,
	type LifecycleRecorder,
	renderLifecycle,
	strandedByCrash,
} from "./lifecycle.ts";
export {
	createNetworkRecorder,
	type LoadingFailed,
	type LoadingFinished,
	type NetworkEvent,
	type NetworkRecorder,
	type NetworkRequest,
	type RedirectHop,
	type RequestSent,
	type RequestState,
	type ResourceTiming,
	type ResponseReceived,
} from "./network.ts";
export {
	anyUrlShortened,
	type RequestQuery,
	renderRequests,
	requestStatus,
} from "./requests.ts";
export {
	foldSockets,
	renderSockets,
	type SocketEvent,
	type SocketFrame,
	type SocketRecord,
} from "./sockets.ts";
export { type Captured, renderLogs } from "./view.ts";
