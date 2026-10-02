import {EmuHost} from "../../src/emu/host";
import {PcmRing} from "../../src/ui/audio";

/** tiny BIOS: endless loop at the reset vector */
function loopBios() {
	const bios = new ArrayBuffer(512 * 1024);
	const v = new Int32Array(bios);
	v[0] = (0x02 << 26) | ((0xbfc00000 >>> 2) & 0x3ffffff); // J 0xbfc00000
	v[1] = 0;
	return bios;
}

function makeHost() {
	const out = [];
	const host = new EmuHost((msg) => out.push(msg));
	let presents = 0;
	const pixels = new Uint32Array(320 * 240);
	host.display = {
		backend: "test",
		resize() {},
		frameBuffer: () => pixels,
		present() { presents++; },
		setViewport() {},
	};
	host.boot({bios: loopBios(), card: null, disc: null, exe: null});
	host.psx.stop(); // drive frames by hand
	return {host, out, presents: () => presents};
}

/** runs one emulated frame through the host's per-tick hook */
function frame(host, frames = 1) {
	for (let i = 0; i < frames; i++) host.psx.runFrame(performance.now() + 1e9);
	host.psx.onFrame(frames);
}

it("boots, applies input and presents only new frames", () => {
	const {host, out, presents} = makeHost();
	expect(out.find((m) => m.type === "status").key).toBe("loadingBios");
	host.handle({type: "buttons", mask: 0x0001});
	frame(host);
	expect(host.psx.joypad.buttons).toBe(0xfffe);
	expect(presents()).toBe(1);
	frame(host, 0); // high-refresh tick without a new frame
	expect(presents()).toBe(1);
	host.handle({type: "visible", value: false});
	frame(host);
	expect(presents()).toBe(1);
});

it("streams audio to the sink and steers by its reported level", () => {
	const {host} = makeHost();
	const sent = [];
	const port = {
		onmessage: null,
		postMessage(msg) { sent.push(msg); },
	};
	host.handle({type: "audioPort", port});
	frame(host);
	expect(sent.length).toBe(1);
	const pairs = sent[0].data.length >> 1;
	expect(pairs).toBeGreaterThan(700);
	expect(host.psx.spu.bufLen).toBe(0);
	// nothing acknowledged yet: everything sent counts as queued
	expect(host.psx.audioQueued).toBe(pairs);
	port.onmessage({data: {type: "level", pairs: 5000, received: pairs}});
	frame(host);
	expect(host.psx.audioQueued).toBe(5000 + (sent[1].data.length >> 1));
	// over-full sink: the next frame generates fewer samples
	frame(host);
	expect(sent[2].data.length >> 1).toBeLessThan(735);
});

it("keeps a transferred disc across reboots", () => {
	const {host} = makeHost();
	const buffer = new ArrayBuffer(2352 * 32);
	host.boot({bios: loopBios(), card: null, exe: null,
		disc: {id: 7, buffer, isRaw: true, tracks: null}});
	expect(host.psx.cdrom.hasDisc).toBe(true);
	host.boot({bios: loopBios(), card: null, exe: null,
		disc: {id: 7, buffer: null, isRaw: true, tracks: null}});
	expect(host.psx.cdrom.hasDisc).toBe(true);
	host.boot({bios: loopBios(), card: null, exe: null, disc: null});
	expect(host.psx.cdrom.hasDisc).toBe(false);
	host.stop();
});

it("ring buffer primes, plays in order and drops the oldest on overflow", () => {
	const ring = new PcmRing();
	const l = new Float32Array(128), r = new Float32Array(128);
	ring.push(new Float32Array([0.5, -0.5]));
	ring.pull(l, r);
	expect(l[0]).toBe(0); // not primed yet: silence
	const chunk = new Float32Array(ring.prime * 2);
	for (let i = 0; i < ring.prime; i++) { chunk[i * 2] = i; chunk[i * 2 + 1] = -i; }
	ring.push(chunk);
	ring.pull(l, r);
	expect(l[0]).toBe(0.5);
	expect(r[0]).toBe(-0.5);
	expect(l[1]).toBe(0);
	expect(l[2]).toBe(1);
	const big = new Float32Array(ring.cap * 2 + 20);
	ring.push(big);
	expect(ring.count).toBe(ring.cap);
});
