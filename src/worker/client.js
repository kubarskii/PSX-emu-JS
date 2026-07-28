/**
 * Main-thread client for the PSX emulation worker.
 *
 * Owns the Worker instance, the display canvas (compositing ImageBitmaps
 * produced by the worker), and the audio pipeline (a lock-free ring
 * buffer fed by the worker, drained by a ScriptProcessor).
 *
 * When the worker or required browser APIs (OffscreenCanvas, module
 * Workers) are unavailable, `supported` is false and the caller falls
 * back to the existing main-thread PSX path.
 *
 * Lifecycle:
 *   const client = new WorkerClient(canvas);
 *   if (!client.supported) fallback();
 *   await client.start();                    // worker "ready"
 *   const status = await client.boot(opts);  // worker "booted"
 *   client.sendInput(mask);                  // every rAF
 *   client.drainAudio(left, right);          // every audio quantum
 *   client.stop();  /  client.destroy();
 */

export class WorkerClient {

	/**
	 * @param {HTMLCanvasElement} canvas - the visible display canvas
	 */
	constructor(canvas) {
		this.canvas = canvas;
		this.ctx = canvas.getContext("2d", {alpha: false});
		this.worker = null;

		// lock-free single-producer single-consumer ring buffer for
		// interleaved stereo floats (size MUST be a power of two)
		const SZ = 1 << 15; // 32768 floats ≈ 373 ms at 44.1 kHz stereo
		this._audioBuf = new Float32Array(SZ);
		this._audioMask = SZ - 1;
		this._audioW = 0;
		this._audioR = 0;

		// callbacks (set by index.js to match the existing main-thread hooks)
		this.onTty = null;
		this.onStats = null;
		this.onCardSave = null;

		this._readyResolve = null;
		this._bootResolvers = [];
	}

	/** true when the browser can run the worker path */
	get supported() {
		return typeof Worker !== "undefined" &&
			typeof OffscreenCanvas !== "undefined" &&
			typeof createImageBitmap === "function";
	}

	/**
	 * Creates the worker and resolves once it reports "ready".
	 * @return {Promise<void>}
	 */
	start() {
		this.worker = new Worker(
			new URL("./psx-worker.js", import.meta.url),
			{type: "module"},
		);
		this.worker.onmessage = (e) => this._onMessage(e.data);
		this.worker.onerror = (e) => {
			console.error("psx-worker error:", e.message || e);
		};

		return new Promise((resolve) => {
			this._readyResolve = resolve;
			this.worker.postMessage({type: "init"});
		});
	}

	/**
	 * @param {object} msg
	 */
	_onMessage(msg) {
		switch (msg.type) {
		case "ready":
			if (this._readyResolve !== null) {
				const r = this._readyResolve;
				this._readyResolve = null;
				r();
			}
			break;

		case "frame":
			this._drawFrame(msg.bitmap);
			break;

		case "audio":
			this._pushAudio(msg.samples);
			break;

		case "tty":
			if (this.onTty !== null) this.onTty(msg.ch);
			break;

		case "stats":
			if (this.onStats !== null) {
				this.onStats({ips: msg.ips, emulationSpeed: msg.speed});
			}
			break;

		case "booted":
			if (this._bootResolvers.length > 0) {
				this._bootResolvers.shift()(msg.status);
			}
			break;

		case "cardSave":
			if (this.onCardSave !== null) this.onCardSave(msg.buffer);
			break;
		}
	}

	/**
	 * Composite the worker-produced bitmap onto the visible canvas.
	 * @param {ImageBitmap} bitmap
	 */
	_drawFrame(bitmap) {
		const cv = this.canvas;
		if (cv.width !== bitmap.width) cv.width = bitmap.width;
		if (cv.height !== bitmap.height) cv.height = bitmap.height;
		this.ctx.drawImage(bitmap, 0, 0);
		bitmap.close();
	}

	/**
	 * Append interleaved stereo samples to the ring buffer.
	 * @param {Float32Array} samples
	 */
	_pushAudio(samples) {
		const buf = this._audioBuf;
		const mask = this._audioMask;
		const n = samples.length;
		for (let i = 0; i < n; i++) {
			buf[this._audioW] = samples[i];
			this._audioW = (this._audioW + 1) & mask;
		}
	}

	/**
	 * Drain stereo pairs into the output channels (called by the
	 * ScriptProcessor's onaudioprocess).  On underrun the remaining
	 * slots are filled with silence rather than blocking.
	 * @param {Float32Array} left
	 * @param {Float32Array} right
	 */
	drainAudio(left, right) {
		const buf = this._audioBuf;
		const mask = this._audioMask;
		const n = left.length;
		for (let i = 0; i < n; i++) {
			if (this._audioR !== this._audioW) {
				left[i] = buf[this._audioR];
				this._audioR = (this._audioR + 1) & mask;
				right[i] = buf[this._audioR];
				this._audioR = (this._audioR + 1) & mask;
			} else {
				left[i] = 0;
				right[i] = 0;
			}
		}
	}

	/**
	 * Boot the machine with the given media.
	 *
	 * ArrayBuffers are structured-cloned (not transferred) so the main
	 * thread retains copies — the user may re-boot the same disc/BIOS
	 * without re-reading it from disk.
	 *
	 * @param {object} opts
	 * @param {ArrayBuffer} opts.bios
	 * @param {{buffer:ArrayBuffer,isRaw:boolean,tracks:*}|null} [opts.disc]
	 * @param {ArrayBuffer|null} [opts.exe]
	 * @param {ArrayBuffer|null} [opts.card]
	 * @param {boolean} [opts.fastBoot]
	 * @return {Promise<string>} status key ("bios"|"fastBoot"|"exe")
	 */
	boot(opts) {
		return new Promise((resolve) => {
			this._bootResolvers.push(resolve);
			this.worker.postMessage({
				type: "boot",
				bios: opts.bios,
				disc: opts.disc || null,
				exe: opts.exe || null,
				card: opts.card || null,
				fastBoot: opts.fastBoot !== false,
			});
		});
	}

	/**
	 * Send the joypad button mask (active-low, same encoding as the
	 * main-thread path).  Called once per rAF on the main thread.
	 * @param {number} mask
	 */
	sendInput(mask) {
		if (this.worker !== null) {
			this.worker.postMessage({type: "input", mask});
		}
	}

	/** Signal the worker to stop emulating (does not terminate). */
	stop() {
		if (this.worker !== null) {
			this.worker.postMessage({type: "stop"});
		}
	}

	/** Terminate the worker and release resources. */
	destroy() {
		if (this.worker !== null) {
			this.worker.terminate();
			this.worker = null;
		}
	}
}
