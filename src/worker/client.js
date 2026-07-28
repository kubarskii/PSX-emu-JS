/**
 * Main-thread client for the PSX emulation worker.
 * Owns the Worker instance, the display canvas (compositing ImageBitmaps
 * produced by the worker), and the audio pipeline (a lock-free ring
 * buffer fed by the worker, drained by a ScriptProcessor).
 */

export class WorkerClient {
	constructor(canvas) {
		this.canvas = canvas;
		this.ctx = canvas.getContext("2d", {alpha: false});
		this.worker = null;
		const SZ = 1 << 15;
		this._audioBuf = new Float32Array(SZ);
		this._audioMask = SZ - 1;
		this._audioW = 0;
		this._audioR = 0;
		this.onTty = null;
		this.onStats = null;
		this.onCardSave = null;
		this._readyResolve = null;
		this._bootResolvers = [];
	}

	get supported() {
		return typeof Worker !== "undefined" &&
			typeof OffscreenCanvas !== "undefined" &&
			typeof createImageBitmap === "function";
	}

	start() {
		this.worker = new Worker(new URL("./psx-worker.js", import.meta.url), {type: "module"});
		this.worker.onmessage = (e) => this._onMessage(e.data);
		this.worker.onerror = (e) => console.error("psx-worker error:", e.message || e);
		return new Promise((resolve) => {
			this._readyResolve = resolve;
			this.worker.postMessage({type: "init"});
		});
	}

	_onMessage(msg) {
		switch (msg.type) {
		case "ready":
			if (this._readyResolve !== null) { const r = this._readyResolve; this._readyResolve = null; r(); }
			break;
		case "frame": this._drawFrame(msg.bitmap); break;
		case "audio": this._pushAudio(msg.samples); break;
		case "tty": if (this.onTty !== null) this.onTty(msg.ch); break;
		case "stats": if (this.onStats !== null) this.onStats({ips: msg.ips, emulationSpeed: msg.speed}); break;
		case "booted": if (this._bootResolvers.length > 0) this._bootResolvers.shift()(msg.status); break;
		case "cardSave": if (this.onCardSave !== null) this.onCardSave(msg.buffer); break;
		}
	}

	_drawFrame(bitmap) {
		const cv = this.canvas;
		if (cv.width !== bitmap.width) cv.width = bitmap.width;
		if (cv.height !== bitmap.height) cv.height = bitmap.height;
		this.ctx.drawImage(bitmap, 0, 0);
		bitmap.close();
	}

	_pushAudio(samples) {
		const buf = this._audioBuf;
		const mask = this._audioMask;
		const n = samples.length;
		for (let i = 0; i < n; i++) { buf[this._audioW] = samples[i]; this._audioW = (this._audioW + 1) & mask; }
	}

	drainAudio(left, right) {
		const buf = this._audioBuf;
		const mask = this._audioMask;
		const n = left.length;
		for (let i = 0; i < n; i++) {
			if (this._audioR !== this._audioW) {
				left[i] = buf[this._audioR]; this._audioR = (this._audioR + 1) & mask;
				right[i] = buf[this._audioR]; this._audioR = (this._audioR + 1) & mask;
			} else { left[i] = 0; right[i] = 0; }
		}
	}

	boot(opts) {
		return new Promise((resolve) => {
			this._bootResolvers.push(resolve);
			this.worker.postMessage({type: "boot", bios: opts.bios, disc: opts.disc || null, exe: opts.exe || null, card: opts.card || null, fastBoot: opts.fastBoot !== false});
		});
	}

	sendInput(mask) { if (this.worker !== null) this.worker.postMessage({type: "input", mask}); }
	stop() { if (this.worker !== null) this.worker.postMessage({type: "stop"}); }
	destroy() { if (this.worker !== null) { this.worker.terminate(); this.worker = null; } }
}
