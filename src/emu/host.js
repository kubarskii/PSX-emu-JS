/**
 * Emulator host: owns the machine, its display and the frame loop, and
 * talks to the page only through plain messages. The same code runs
 * inside a Web Worker (the default: emulation then never competes with
 * input, layout and compositing for the main thread) or directly on the
 * main thread as a fallback.
 *
 * Page -> host messages: see EmuHost#handle. Host -> page messages go
 * through `emit(msg, transfer)`:
 *   {type: "ready", backend, hwScale}  display created
 *   {type: "jit", mops}               JS engine speed probe (see jit.js)
 *   {type: "status", key}             boot mode (i18n key)
 *   {type: "stats", ips, emulationSpeed, fps}  fps = frames presented
 *   {type: "tty", text}               kernel putchar output
 *   {type: "card", data}              memory-card image to persist
 */

import {PSX} from "../psx";
import {createDisplay} from "../ui/display";
import {measureJit} from "./jit";

/** memory-card writes arrive sector by sector: persist once they settle */
const CARD_SAVE_DELAY_MS = 800;

export class EmuHost {

	/**
	 * @param {(msg: object, transfer?: Transferable[]) => void} emit
	 */
	constructor(emit) {
		this.emit = emit;
		/** @type {PSX | null} */
		this.psx = null;
		this.display = null;
		this.buttons = 0;
		this.hidden = false;
		/** the player screen is on: skip presenting while it isn't */
		this.visible = true;
		/** cached disc image, kept across reboots (id assigned by the page) */
		this.discId = -1;
		this.disc = null;
		/** @type {MessagePort | null} - audio sink (AudioWorklet or fallback) */
		this.audioPort = null;
		/** stereo pairs sent to / acknowledged by the sink */
		this.audioSent = 0;
		this.audioLevel = 0;
		this.audioReceived = 0;
		this._tty = "";
		this._cardTimer = 0;
	}

	/**
	 * @param {HTMLCanvasElement | OffscreenCanvas} canvas
	 * @param {number} gpuScale - 0 = software renderer
	 */
	init(canvas, gpuScale, debugVram = false) {
		/**
		 * debugging aid: present the whole 1024x512 VRAM as 15bpp instead
		 * of the display area (software renderer only: with the hardware
		 * one, rendered pixels live on the host GPU)
		 */
		this.debugVram = debugVram;
		this.display = createDisplay(canvas, debugVram ? 0 : gpuScale);
		this.emit({
			type: "ready",
			backend: this.display.backend,
			hwScale: this.display.hw !== undefined ? this.display.hw.scale : 0,
		});
		this.emit({type: "jit", mops: measureJit()});
	}

	/**
	 * Dispatches one page message.
	 * @param {{type: string}} msg
	 */
	handle(msg) {
		switch (msg.type) {
		case "init": this.init(msg.canvas, msg.gpuScale, msg.debugVram === true); return;
		case "boot": this.boot(msg); return;
		case "stop": this.stop(); return;
		case "buttons": this.buttons = msg.mask; return;
		case "hidden":
			this.hidden = msg.value;
			if (this.psx !== null) this.psx.setHidden(msg.value);
			return;
		case "visible": this.visible = msg.value; return;
		case "viewport": this.display.setViewport(msg.width, msg.height); return;
		case "audioPort": this.setAudioPort(msg.port); return;
		default: return;
		}
	}

	/**
	 * (Re)creates the machine and starts it.
	 * @param {{
	 *   bios: ArrayBuffer,
	 *   card: ArrayBuffer | null,
	 *   disc: {id: number, buffer: ArrayBuffer | null, isRaw: boolean, tracks: object} | null,
	 *   exe: ArrayBuffer | null,
	 * }} cfg - disc.buffer is null when the host already has disc.id
	 */
	boot(cfg) {
		this.stop();
		const disc = cfg.disc;
		if (disc !== null && disc.buffer !== null) {
			this.discId = disc.id;
			this.disc = disc;
		}
		const psx = new PSX();
		this.psx = psx;
		const display = this.display;
		if (display.hw !== undefined) psx.gpu.hw = display.hw;
		psx.setHidden(this.hidden);
		// in a worker a long tick blocks no UI: catch up over more frames
		if (typeof document === "undefined") {
			psx.tickBudgetMs = 50;
			psx.adaptivePacing = true;
		}
		psx.cpu.onTty = (ch) => {
			this._tty += ch;
		};
		this._presents = 0;
		this._presentStamp = performance.now();
		psx.onStats = (stats) => {
			const now = performance.now();
			const fps = this._presents * 1000 / Math.max(1, now - this._presentStamp);
			this._presents = 0;
			this._presentStamp = now;
			this.emit({type: "stats", ips: stats.ips, emulationSpeed: stats.emulationSpeed, fps,
				maxFrameMs: stats.maxFrameMs});
		};
		psx.onHitch = (h) => {
			// goes to the settings TTY log, for bug reports
			this._tty += `[hitch] frame ${h.ms.toFixed(0)} ms: compile ${h.compileMs.toFixed(0)} ms, ` +
				`VRAM readback ${h.readbacks}x ${h.readbackMs.toFixed(0)} ms\n`;
		};
		psx.onFrame = (frames) => this.#frame(frames);
		if (cfg.card !== null) psx.joypad.card.load(cfg.card);
		psx.joypad.card.onWrite = () => this.#scheduleCardSave();

		const useDisc = disc !== null && this.disc !== null && this.discId === disc.id;
		if (useDisc) psx.insertDisc(this.disc.buffer, this.disc.isRaw, this.disc.tracks);
		psx.loadBios(cfg.bios);
		let status;
		if (cfg.exe !== null) {
			psx.sideloadExe(cfg.exe);
			status = "loadingExe";
		} else if (useDisc && psx.fastBootDisc()) {
			status = "fastBoot";
		} else {
			status = "loadingBios";
		}
		this.emit({type: "status", key: status});
		psx.start();
	}

	stop() {
		if (this.psx === null) return;
		this.psx.stop();
		this.#flushCard();
		this.psx = null;
	}

	/**
	 * @param {MessagePort} port - audio sink: receives {type: "pcm",
	 *   data} and answers with {type: "level", pairs, received}
	 */
	setAudioPort(port) {
		this.audioPort = port;
		this.audioSent = 0;
		this.audioLevel = 0;
		this.audioReceived = 0;
		port.onmessage = (e) => {
			const m = e.data;
			if (m.type === "level") {
				this.audioLevel = m.pairs;
				this.audioReceived = m.received;
			}
		};
		if (typeof port.start === "function") port.start();
	}

	/**
	 * Per-tick hook: input in, audio and video out.
	 * @param {number} frames - frames emulated this tick
	 */
	#frame(frames) {
		const psx = this.psx;
		psx.joypad.buttons = (~this.buttons) & 0xffff;
		this.#pushAudio();
		if (this._tty !== "") {
			this.emit({type: "tty", text: this._tty});
			this._tty = "";
		}
		// a 90/120Hz display ticks more often than frames are produced:
		// re-presenting the same frame only burns GPU/CPU time (and a
		// hidden player screen needs no frames at all)
		if (frames === 0 || !this.visible || this.hidden) return;
		const display = this.display;
		this._presents++;
		if (this.debugVram) {
			display.resize(1024, 512);
			psx.gpu.renderVram(display.frameBuffer());
			display.present();
		} else if (display.hw !== undefined) {
			display.present(psx.gpu);
		} else {
			const w = psx.gpu.hres;
			const h = psx.gpu.vres;
			display.resize(w, h);
			psx.gpu.renderDisplay(display.frameBuffer(), w, h);
			display.present();
		}
	}

	/** moves the SPU output to the audio sink and updates the steering */
	#pushAudio() {
		const spu = this.psx.spu;
		const n = spu.bufLen;
		if (this.audioPort === null) {
			// no sink yet (audio starts on the first user gesture)
			spu.bufLen = 0;
			this.psx.audioQueued = 0;
			return;
		}
		if (n > 0) {
			const data = spu.buffer.slice(0, n);
			spu.bufLen = 0;
			this.audioSent += n >> 1;
			this.audioPort.postMessage({type: "pcm", data}, [data.buffer]);
		}
		// queued = what the sink last reported + what is still in flight
		const inFlight = Math.max(0, this.audioSent - this.audioReceived);
		this.psx.audioQueued = this.audioLevel + inFlight;
	}

	#scheduleCardSave() {
		clearTimeout(this._cardTimer);
		this._cardTimer = setTimeout(() => this.#flushCard(), CARD_SAVE_DELAY_MS);
	}

	#flushCard() {
		if (this._cardTimer === 0 || this.psx === null) return;
		clearTimeout(this._cardTimer);
		this._cardTimer = 0;
		const data = this.psx.joypad.card.data.slice().buffer;
		this.emit({type: "card", data}, [data]);
	}
}
