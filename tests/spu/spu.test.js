import {SPU} from "../../src/spu/spu";

/**
 * Writes an ADPCM block into SPU RAM.
 * @param {SPU} spu
 * @param {number} addr
 * @param {number} shift
 * @param {number} filter
 * @param {number} flags
 * @param {number[]} nibbles - 28 4bit samples
 */
function putBlock(spu, addr, shift, filter, flags, nibbles) {
	spu.ram[addr] = (filter << 4) | shift;
	spu.ram[addr + 1] = flags;
	for (let i = 0; i < 14; i++) {
		spu.ram[addr + 2 + i] = (nibbles[i * 2] & 0xf) | ((nibbles[i * 2 + 1] & 0xf) << 4);
	}
}

/** configures voice 0 with instant attack and audible volume */
function voiceOn(spu, startAddr) {
	spu.write16(0x1aa, 0xc000);        // SPUCNT: enable + unmute
	spu.write16(0x180, 0x3fff);        // main volume L
	spu.write16(0x182, 0x3fff);        // main volume R
	spu.write16(0x000, 0x3fff);        // voice0 vol L
	spu.write16(0x002, 0x3fff);        // voice0 vol R
	spu.write16(0x004, 0x1000);        // pitch = 44100Hz
	spu.write16(0x006, startAddr / 8); // start address
	spu.write16(0x008, 0x000f);        // ADSR: fastest attack, sustain max
	spu.write16(0x00a, 0x0000);
	spu.write16(0x188, 0x0001);        // KON voice 0
}

describe("SPU synthesis", () => {
	it("decodes a flat ADPCM block (filter 0)", () => {
		const spu = new SPU();
		// nibble 7 with shift 0 -> sample = 7 << 12 = 28672
		putBlock(spu, 0x1000, 0, 0, 0x2, new Array(28).fill(7));
		voiceOn(spu, 0x1000);
		spu.generate(4); // stay inside the first block
		const v = spu.voices[0];
		expect(Array.from(v.block.slice(0, 4))).toEqual([28672, 28672, 28672, 28672]);
	});

	it("produces audible output after key-on", () => {
		const spu = new SPU();
		putBlock(spu, 0x1000, 0, 0, 0x2, new Array(28).fill(7));
		voiceOn(spu, 0x1000);
		spu.generate(200);
		const out = new Float32Array(400);
		spu.drain(out);
		let peak = 0;
		for (const s of out) peak = Math.max(peak, Math.abs(s));
		expect(peak).toBeGreaterThan(0.05);
	});

	it("silence when the SPU is muted", () => {
		const spu = new SPU();
		putBlock(spu, 0x1000, 0, 0, 0x2, new Array(28).fill(7));
		voiceOn(spu, 0x1000);
		spu.write16(0x1aa, 0x8000); // enabled but muted
		spu.generate(100);
		const out = new Float32Array(200);
		spu.drain(out);
		expect(Math.max(...out.map(Math.abs))).toBe(0);
	});

	it("sets ENDX and stops at a non-repeating loop end", () => {
		const spu = new SPU();
		putBlock(spu, 0x1000, 0, 0, 0x1, new Array(28).fill(7)); // end, no repeat
		voiceOn(spu, 0x1000);
		spu.generate(64);
		expect(spu.read16(0x19c) & 1).toBe(1); // ENDX voice 0
		expect(spu.voices[0].envVol).toBe(0);
	});

	it("loops through the repeat address when flagged", () => {
		const spu = new SPU();
		putBlock(spu, 0x1000, 0, 0, 0x6, new Array(28).fill(5)); // loop start + repeat... flags 4|2
		putBlock(spu, 0x1010, 0, 0, 0x3, new Array(28).fill(3)); // end + repeat
		voiceOn(spu, 0x1000);
		spu.generate(90); // enough to wrap: 56 samples of data
		const v = spu.voices[0];
		expect(v.phase).not.toBe(0);       // still playing
		expect(spu.read16(0x19c) & 1).toBe(1);
	});

	it("ADSR attack ramps the envelope up", () => {
		const spu = new SPU();
		putBlock(spu, 0x1000, 0, 0, 0x2, new Array(28).fill(7));
		voiceOn(spu, 0x1000);
		spu.write16(0x008, (20 << 8) | 0xf); // slower attack
		spu.write16(0x188, 1);               // re-key
		spu.generate(4);
		const early = spu.voices[0].envVol;
		spu.generate(60);
		const later = spu.voices[0].envVol;
		expect(later).toBeGreaterThan(early);
	});

	it("drain zero-fills on underrun", () => {
		const spu = new SPU();
		const out = new Float32Array(64);
		out.fill(0.5);
		const got = spu.drain(out);
		expect(got).toBe(0);
		expect(out[0]).toBe(0);
	});

	it("keeps register state round-tripping", () => {
		const spu = new SPU();
		spu.write16(0x1aa, 0xc001);
		expect(spu.read16(0x1aa)).toBe(0xc001);
		expect(spu.read16(0x1ae) & 0x3f).toBe(0x01); // SPUSTAT mirrors mode
	});

	it("raises IRQ9 when a voice fetches the block at the IRQ address", () => {
		const raised = [];
		const spu = new SPU((bit) => raised.push(bit));
		putBlock(spu, 0x1000, 0, 0, 0x2, new Array(28).fill(7));
		voiceOn(spu, 0x1000);
		spu.write16(0x1a4, 0x1000 / 8);      // IRQ address inside the block
		spu.write16(0x1aa, 0xc040);          // SPUCNT: enable + unmute + IRQ enable
		spu.generate(4);                      // voice decodes the block
		expect(raised).toEqual([9]);
		expect(spu.read16(0x1ae) & 0x40).toBe(0x40); // SPUSTAT IRQ flag
		spu.generate(4);                      // still inside: no second edge
		expect(raised).toEqual([9]);
		spu.write16(0x1aa, 0xc000);           // clearing SPUCNT bit6 acks
		expect(spu.read16(0x1ae) & 0x40).toBe(0);
	});

	it("raises IRQ9 when a transfer write crosses the IRQ address", () => {
		const raised = [];
		const spu = new SPU((bit) => raised.push(bit));
		spu.write16(0x1aa, 0xc040);          // IRQ enable
		spu.write16(0x1a4, 0x2000 / 8);      // IRQ address
		spu.write16(0x1a6, 0x2000 / 8);      // transfer address
		spu.write16(0x1a8, 0x1234);          // FIFO write at the IRQ address
		expect(raised).toEqual([9]);
	});

	it("does not raise IRQ9 when disabled", () => {
		const raised = [];
		const spu = new SPU((bit) => raised.push(bit));
		putBlock(spu, 0x1000, 0, 0, 0x2, new Array(28).fill(7));
		voiceOn(spu, 0x1000);                // SPUCNT without bit6
		spu.write16(0x1a4, 0x1000 / 8);
		spu.generate(4);
		expect(raised).toEqual([]);
	});
});
