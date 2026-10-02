/**
 * Page-side handle to the emulator host: runs it in a Web Worker with an
 * OffscreenCanvas when the browser supports both, on the main thread
 * otherwise (or when the worker fails to come up). Either way the page
 * talks to it with the same messages (see host.js).
 */

/**
 * @return {boolean} - the worker mode is available
 */
function workerSupported(canvas) {
	if (typeof Worker !== "function" || typeof OffscreenCanvas !== "function") return false;
	if (typeof canvas.transferControlToOffscreen !== "function") return false;
	try {
		// debug switch: ?worker=0 keeps everything on the main thread
		if (/[?&]worker=0\b/.test(location.search)) return false;
	} catch {
		// no location: fine
	}
	return true;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} gpuScale - 0 = software renderer
 * @param {(msg: object) => void} onMessage - host -> page messages
 * @return {{
 *   mode: "pending" | "fallback" | "worker" | "main",
 *   canvas: HTMLCanvasElement,
 *   post: (msg: object, transfer?: Transferable[]) => void,
 * }}
 */
export function createEmulator(canvas, gpuScale, onMessage) {
	/** messages sent before the backend is up, replayed in order */
	const queue = [];
	let backend = null;
	const emu = {
		mode: "pending",
		canvas,
		post(msg, transfer) {
			if (backend !== null) backend(msg, transfer);
			else queue.push([msg, transfer]);
		},
	};
	const flush = () => {
		for (const [msg, transfer] of queue.splice(0)) backend(msg, transfer);
	};

	const startMain = (target) => {
		emu.canvas = target;
		// loaded on demand: in worker mode the page bundle doesn't carry
		// a second copy of the whole machine
		import("./host").then(({EmuHost}) => {
			const host = new EmuHost((msg) => onMessage(msg));
			emu.mode = "main";
			host.handle({type: "hidden", value: document.hidden});
			host.init(target, gpuScale);
			backend = (msg) => host.handle(msg);
			flush();
		}).catch((err) => onMessage({type: "error", message: String(err)}));
	};

	if (!workerSupported(canvas)) {
		startMain(canvas);
		return emu;
	}

	let worker;
	try {
		worker = new Worker(new URL("./worker.js", import.meta.url));
	} catch {
		startMain(canvas);
		return emu;
	}
	let ready = false;
	const fail = () => {
		if (ready || emu.mode !== "pending") return;
		emu.mode = "fallback";
		worker.terminate();
		// a canvas handed to OffscreenCanvas can never get a context
		// on this side again: swap in a fresh element
		const fresh = canvas.cloneNode(false);
		canvas.replaceWith(fresh);
		startMain(fresh);
	};
	worker.onmessage = (e) => {
		const msg = e.data;
		if (!ready) {
			if (msg.type === "error") {
				fail();
				return;
			}
			if (msg.type === "ready") {
				ready = true;
				emu.mode = "worker";
				backend = (m, transfer) => worker.postMessage(m, transfer || []);
				flush();
			}
		}
		onMessage(msg);
	};
	worker.onerror = (e) => {
		if (!ready) {
			e.preventDefault();
			fail();
			return;
		}
		onMessage({type: "error", message: e.message || "worker error"});
	};
	try {
		const offscreen = canvas.transferControlToOffscreen();
		worker.postMessage({type: "init", canvas: offscreen, gpuScale}, [offscreen]);
	} catch {
		worker.terminate();
		startMain(canvas);
	}
	return emu;
}
