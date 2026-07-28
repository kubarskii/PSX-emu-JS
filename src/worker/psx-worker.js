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
 */

import {PSX} from "../psx";

let psx = null;
let offCanvas = null;
let offCtx = null;
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
		if (psx !== null) { psx.stop(); psx = null; }
		break;
	}
};

function boot(msg) {
	if (psx !== null) psx.stop();
	psx = new PSX();
	psx.cpu.onTty = (ch) => self.postMessage({type: "tty", ch});
	psx.onStats = (stats) => self.postMessage({type: "stats", ips: stats.ips, speed: stats.emulationSpeed});
	psx.onFrame = onFrame;
	if (msg.card !== null) psx.joypad.card.load(msg.card);
	psx.joypad.card.onWrite = () => {
		if (psx === null) return;
		const buf = psx.joypad.card.data.buffer.slice();
		self.postMessage({type: "cardSave", buffer: buf}, [buf]);
	};
	if (msg.disc !== null) psx.insertDisc(msg.disc.buffer, msg.disc.isRaw, msg.disc.tracks);
	psx.loadBios(msg.bios);
	let status;
	if (msg.exe !== null) { psx.sideloadExe(msg.exe); status = "exe"; }
	else if (msg.disc !== null && msg.fastBoot && psx.fastBootDisc()) status = "fastBoot";
	else status = "bios";
	psx.start();
	self.postMessage({type: "booted", status});
}

function onFrame() {
	const w = psx.gpu.hres;
	const h = psx.gpu.vres;
	if (w !== fbW || h !== fbH) {
		fbW = w; fbH = h;
		offCanvas.width = w; offCanvas.height = h;
		frameBuf = new Uint32Array(w * h);
	}
	psx.gpu.renderDisplay(frameBuf, w, h);
	const img = new ImageData(new Uint8ClampedArray(frameBuf.buffer), w, h);
	offCtx.putImageData(img, 0, 0);
	const bitmap = offCanvas.transferToImageBitmap();
	self.postMessage({type: "frame", bitmap}, [bitmap]);
	while (psx.spu.bufLen >= 2048) {
		const tmp = new Float32Array(2048);
		psx.spu.drain(tmp);
		self.postMessage({type: "audio", samples: tmp}, [tmp.buffer]);
	}
}
