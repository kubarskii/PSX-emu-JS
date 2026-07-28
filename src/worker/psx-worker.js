/**
 * PSX emulation Web Worker.
 *
 * Runs the full machine — CPU, GPU software rasterizer (#triangle /
 * #texel), SPU, DMA, CDROM, timers, MDEC, joypad — off the main
 * thread.  The main thread stays free for UI, input polling and audio
 * playback, eliminating the jank that software 3D rasterization causes
 * when it runs interleaved with rAF on the main thread.
 *
 * Each emulated frame:
 *   1.  CPU executes → GP0 commands → GPU rasterizes triangles/rects/
 *       lines into VRAM (all inside this worker, never on main thread).
 *   2.  gpu.renderDisplay() converts the display-area VRAM region to
 *       RGBA32 and writes it into an OffscreenCanvas via putImageData.
 *   3.  The OffscreenCanvas is transferred to the main thread as an
 *       ImageBitmap (zero-copy via the transfer list).
 *   4.  Available SPU samples are drained and sent to the main thread
 *       ring buffer.
 *
 * Synchronous-access concern: the entire PSX lives inside the worker,
 * so GPUSTAT reads, VRAM->CPU transfers and DMA feedback all resolve
 * synchronously within the worker — no cross-thread fence needed.
 *
 * Communication protocol (all messages are plain objects on e.data):
 *
 *   Main → Worker
 *     {type:"init"}                         — worker bootstraps OffscreenCanvas
 *     {type:"boot",bios,disc,exe,card,...}  — (re)create + start the machine
 *     {type:"input",mask}                   — joypad button mask (active-low)
 *     {type:"stop"}                         — halt emulation
 *
 *   Worker → Main
 *     {type:"ready"}                        — init complete
 *     {type:"booted",status}                — machine started ("bios"|"fastBoot"|"exe")
 *     {type:"frame",bitmap}                 — rendered frame (transferable ImageBitmap)
 *     {type:"audio",samples}                — interleaved stereo Float32Array (transferable)
 *     {type:"tty",ch}                       — single TTY character
 *     {type:"stats",ips,speed}              — perf snapshot
 *     {type:"cardSave",buffer}              — memory-card image for persistence
 */

import {PSX} from "../psx";

/** @type {PSX | null} */
let psx = null;

/** @type {OffscreenCanvas} */
let offCanvas = null;
/** @type {OffscreenCanvasRenderingContext2D} */
let offCtx = null;

/** reused display-area frame buffer (ABGR Uint32, little-endian) */
let frameBuf = null;
let fbW = 0;
let fbH = 0;

self.onmessage = (e) => {
	const msg = e.data;
	switch (msg.type) {
	case "init":
		offCanvas = new OffscreenCanvas(320, 240);
		offCtx = offCanvas.getContext("2d", {alpha: false});
		self.postMessage({type: "ready"});
		break;

	case "boot":
		boot(msg);
		break;

	case "input":
		if (psx !== null) psx.joypad.buttons = (~msg.mask) & 0xffff;
		break;

	case "stop":
		if (psx !== null) {
			psx.stop();
			psx = null;
		}
		break;
	}
};

/**
 * (Re)creates the machine from media transferred by the main thread
 * and starts emulation.  ArrayBuffers arrive as structured clones
 * (not transferred) so the main thread retains its copies for the
 * next boot.
 *
 * @param {object} msg - boot parameters
 */
function boot(msg) {
	if (psx !== null) psx.stop();
	psx = new PSX();

	// ---- callbacks that cross back to the main thread ----

	psx.cpu.onTty = (ch) => self.postMessage({type: "tty", ch});

	psx.onStats = (stats) => self.postMessage({
		type: "stats",
		ips: stats.ips,
		speed: stats.emulationSpeed,
	});

	psx.onFrame = onFrame;

	// ---- media ----

	if (msg.card !== null) psx.joypad.card.load(msg.card);
	psx.joypad.card.onWrite = () => {
		if (psx === null) return;
		const buf = psx.joypad.card.data.buffer.slice();
		self.postMessage({type: "cardSave", buffer: buf}, [buf]);
	};

	if (msg.disc !== null) {
		psx.insertDisc(msg.disc.buffer, msg.disc.isRaw, msg.disc.tracks);
	}
	psx.loadBios(msg.bios);

	let status;
	if (msg.exe !== null) {
		psx.sideloadExe(msg.exe);
		status = "exe";
	} else if (msg.disc !== null && msg.fastBoot && psx.fastBootDisc()) {
		status = "fastBoot";
	} else {
		status = "bios";
	}

	psx.start();
	self.postMessage({type: "booted", status});
}

/**
 * Per-frame callback: rasterisation for this frame is already complete
 * (it happened synchronously during runFrame's scanline loop).  We
 * render the display area, transfer the bitmap, and push audio.
 */
function onFrame() {
	const w = psx.gpu.hres;
	const h = psx.gpu.vres;

	if (w !== fbW || h !== fbH) {
		fbW = w;
		fbH = h;
		offCanvas.width = w;
		offCanvas.height = h;
		frameBuf = new Uint32Array(w * h);
	}

	// renderDisplay fills frameBuf with ABGR uint32 values; on
	// little-endian machines the byte layout (R,G,B,A) matches
	// what ImageData expects, so we can wrap the buffer directly.
	psx.gpu.renderDisplay(frameBuf, w, h);
	const img = new ImageData(new Uint8ClampedArray(frameBuf.buffer), w, h);
	offCtx.putImageData(img, 0, 0);

	const bitmap = offCanvas.transferToImageBitmap();
	self.postMessage({type: "frame", bitmap}, [bitmap]);

	// drain SPU samples produced this frame.  The internal SPU buffer
	// holds ~4096+ pairs after generate(); send 1024-pair batches so
	// the main thread ring buffer stays filled without flooding it.
	while (psx.spu.bufLen >= 2048) {
		const tmp = new Float32Array(2048);
		psx.spu.drain(tmp);
		self.postMessage({type: "audio", samples: tmp}, [tmp.buffer]);
	}
}
