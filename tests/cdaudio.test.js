/** CD audio path: XA-ADPCM decode and CDDA PCM through the SPU mix. */
import {SPU} from "../src/spu/spu";
import {CDROM} from "../src/cdrom/cdrom";

/** builds a CDROM whose delayed events run via a manual queue */
function makeCd() {
	const queue = [];
	const cd = new CDROM({
		schedule: (cycles, fn) => queue.push(fn),
		scheduleKind: (cycles, target, kind, gen) => queue.push(() => target._onEvent(kind, gen)),
	}, () => {});
	return {cd, run: () => { while (queue.length) queue.shift()(); }};
}

/** one raw sector with an XA real-time audio subheader and given units */
function xaSector(coding, fillByte) {
	const s = new Uint8Array(2352);
	s[16] = 1;          // file
	s[17] = 1;          // channel
	s[18] = 0x64;       // submode: real-time + audio + form2
	s[19] = coding;
	for (let g = 0; g < 18; g++) {
		const gb = 24 + g * 128;
		// params: filter 0, shift 0 for every unit
		for (let i = 0; i < 16; i++) s[gb + i] = 0;
		for (let i = 16; i < 128; i++) s[gb + i] = fillByte;
	}
	return s;
}

it("decodes an XA stereo sector into the SPU cd ring", () => {
	const spu = new SPU();
	const {cd} = makeCd();
	cd.spu = spu;
	const disc = new Uint8Array(2352 * 4);
	disc.set(xaSector(0x01, 0x11), 0); // stereo, 37800Hz, nibbles = +1
	cd.insert(disc.buffer, true);
	cd.mode = 0x40; // XA enabled, no filter
	cd.reading = true;
	cd.readLba = 0;
	cd._onEvent(1 /* CD.SECTOR */, cd.gen);

	// nibble +1, shift 0 -> first sample 1<<12 = 4096 on both channels
	const got = (cd.spu.cdHead - cd.spu.cdTail) & (spu.cdRing.length - 1);
	expect(got).toBeGreaterThan(3000); // ~2016 pairs resampled 37800->44100
	expect(spu.cdRing[spu.cdTail]).toBe(4096);
	expect(cd.readLba).toBe(1); // consumed, stream advanced
});

it("respects the Setfilter file/channel when enabled", () => {
	const spu = new SPU();
	const {cd} = makeCd();
	cd.spu = spu;
	const disc = new Uint8Array(2352 * 4);
	disc.set(xaSector(0x01, 0x11), 0);
	cd.insert(disc.buffer, true);
	cd.mode = 0x48; // XA + filter
	cd.filterFile = 2; // sector has file=1: must be dropped
	cd.filterChannel = 1;
	cd.reading = true;
	cd.readLba = 0;
	cd._onEvent(1, cd.gen);
	expect(spu.cdHead).toBe(spu.cdTail);
});

it("delivers CDDA sectors as PCM on play ticks", () => {
	const spu = new SPU();
	const {cd} = makeCd();
	cd.spu = spu;
	const disc = new Uint8Array(2352 * 8);
	const dv = new DataView(disc.buffer);
	for (let i = 0; i < 1176; i++) dv.setInt16(2352 + i * 2, 1000, true);
	cd.insert(disc.buffer, true);
	cd.tracks = [{number: 1, startLba: 0, audio: true}];
	cd.playing = true;
	cd.playLba = 1;
	cd._onEvent(20 /* CD.CDDA_TICK */, cd.gen);
	expect(spu.cdRing[spu.cdTail]).toBe(1000);
	expect(cd.playLba).toBe(2);
});

it("mixes the cd ring into the output honoring volume and enable", () => {
	const spu = new SPU();
	const pcm = new Int16Array([16384, -16384, 16384, -16384]);
	spu.pushCdAudio(pcm, 44100);
	// full cd + main volume, SPUCNT: cd enable + unmute
	spu.regs[0x180 >> 1] = 0x3fff;
	spu.regs[0x182 >> 1] = 0x3fff;
	spu.regs[0x1b0 >> 1] = 0x3fff;
	spu.regs[0x1b2 >> 1] = 0x3fff;
	spu.regs[0x1aa >> 1] = 0xc001;
	spu.generate(1);
	expect(spu.buffer[0]).toBeCloseTo(16384 * 2 / 32768 / 2, 1);
	expect(spu.buffer[1]).toBeCloseTo(-16384 * 2 / 32768 / 2, 1);

	// with cd enable off the ring must not leak into the mix
	const spu2 = new SPU();
	spu2.pushCdAudio(pcm, 44100);
	spu2.regs[0x180 >> 1] = 0x3fff;
	spu2.regs[0x1b0 >> 1] = 0x3fff;
	spu2.regs[0x1aa >> 1] = 0xc000;
	spu2.generate(1);
	expect(spu2.buffer[0]).toBe(0);
});
