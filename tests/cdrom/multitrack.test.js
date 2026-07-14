import {parseCue, buildDisc, buildDiscStreaming} from "../../src/loader/cue";
import {CDROM} from "../../src/cdrom/cdrom";

const CUE = `FILE "game (Track 1).bin" BINARY
  TRACK 01 MODE2/2352
    INDEX 01 00:00:00
FILE "game (Track 2).bin" BINARY
  TRACK 02 AUDIO
    INDEX 00 00:00:00
    INDEX 01 00:02:00
FILE "game (Track 3).bin" BINARY
  TRACK 03 AUDIO
    INDEX 00 00:00:00
    INDEX 01 00:02:00
`;

describe("cue parsing and disc assembly", () => {
	it("parses tracks with their INDEX 01 offsets", () => {
		const e = parseCue(CUE);
		expect(e.length).toBe(3);
		expect(e[0]).toEqual({file: "game (Track 1).bin", track: 1, audio: false, sectorSize: 2352, index1: 0});
		expect(e[1].audio).toBe(true);
		expect(e[1].index1).toBe(150); // 2 second pregap
		expect(e[2].track).toBe(3);
	});

	it("assembles files into one image with absolute track LBAs", () => {
		const e = parseCue(CUE);
		const buffers = new Map([
			["game (track 1).bin", new ArrayBuffer(2352 * 100)],
			["game (track 2).bin", new ArrayBuffer(2352 * 50)],
			["game (track 3).bin", new ArrayBuffer(2352 * 40)],
		]);
		const disc = buildDisc(e, buffers);
		expect(disc.buffer.byteLength).toBe(2352 * 190);
		expect(disc.tracks).toEqual([
			{number: 1, startLba: 0, audio: false},
			{number: 2, startLba: 100 + 150, audio: true},
			{number: 3, startLba: 150 + 150, audio: true},
		]);
	});

	it("throws when a referenced file is missing", () => {
		const e = parseCue(CUE);
		expect(() => buildDisc(e, new Map())).toThrow(/missing file/);
	});

	it("expands MODE1/2048 files into raw 2352-byte sectors", () => {
		const e = parseCue("FILE \"game.iso\" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n");
		const iso = new Uint8Array(2048 * 3);
		iso[0] = 0xab;             // first data byte of sector 0
		iso[2048] = 0xcd;          // first data byte of sector 1
		const disc = buildDisc(e, new Map([["game.iso", iso.buffer]]));
		expect(disc.buffer.byteLength).toBe(2352 * 3);
		const raw = new Uint8Array(disc.buffer);
		// sync pattern
		expect(raw[0]).toBe(0);
		expect(raw[1]).toBe(0xff);
		expect(raw[11]).toBe(0);
		// BCD MSF of LBA 0 = 00:02:00, mode 2, data at offset 24
		expect(raw[12]).toBe(0x00);
		expect(raw[13]).toBe(0x02);
		expect(raw[14]).toBe(0x00);
		expect(raw[15]).toBe(2);
		expect(raw[24]).toBe(0xab);
		expect(raw[2352 + 14]).toBe(0x01); // frame 1 in BCD
		expect(raw[2352 + 24]).toBe(0xcd);
	});

	it("streaming assembly matches the eager (Map-based) assembly", async () => {
		const e = parseCue(CUE);
		const content = new Map([
			["game (track 1).bin", new Uint8Array(2352 * 100).fill(1)],
			["game (track 2).bin", new Uint8Array(2352 * 50).fill(2)],
			["game (track 3).bin", new Uint8Array(2352 * 40).fill(3)],
		]);
		const buffers = new Map(Array.from(content, ([k, v]) => [k, v.buffer]));
		const eager = buildDisc(e, buffers);

		const sizes = new Map(Array.from(content, ([k, v]) => [k, v.byteLength]));
		const streamed = await buildDiscStreaming(e, sizes, async (name) => content.get(name.toLowerCase()).buffer);

		expect(streamed.tracks).toEqual(eager.tracks);
		expect(new Uint8Array(streamed.buffer)).toEqual(new Uint8Array(eager.buffer));
	});

	it("reports per-file progress in cue order", async () => {
		const e = parseCue(CUE);
		const sizes = new Map([
			["game (track 1).bin", 2352 * 100],
			["game (track 2).bin", 2352 * 50],
			["game (track 3).bin", 2352 * 40],
		]);
		const progress = [];
		await buildDiscStreaming(e, sizes, async (name) => new ArrayBuffer(sizes.get(name.toLowerCase())),
			(done, total, name) => progress.push(`${done}/${total}:${name}`));
		expect(progress).toEqual([
			"1/3:game (Track 1).bin",
			"2/3:game (Track 2).bin",
			"3/3:game (Track 3).bin",
		]);
	});

	it("streaming assembly throws when a referenced file is missing", async () => {
		const e = parseCue(CUE);
		await expect(buildDiscStreaming(e, new Map(), async () => new ArrayBuffer(0)))
			.rejects.toThrow(/missing file/);
	});
});

/** event pump mirroring the machine scheduler */
class Pump {
	constructor() {
		this.events = [];
		this.schedule = (cycles, fn) => this.events.push({left: cycles, fn});
		this.scheduleKind = (cycles, target, kind, gen) =>
			this.events.push({left: cycles, fn: () => {
				if (gen < 0 || gen === target.gen) target._onEvent(kind);
			}});
	}

	run(cycles) {
		for (let guard = 0; guard < 10000 && cycles > 0; guard++) {
			let min = Infinity;
			for (const e of this.events) min = Math.min(min, e.left);
			const step = Math.min(cycles, min === Infinity ? cycles : min);
			cycles -= step;
			const due = [];
			for (let i = this.events.length - 1; i >= 0; i--) {
				this.events[i].left -= step;
				if (this.events[i].left <= 0) {
					due.push(this.events[i].fn);
					this.events.splice(i, 1);
				}
			}
			for (let i = due.length - 1; i >= 0; i--) due[i]();
		}
	}
}

/** @return {{cd: CDROM, pump: Pump}} - with a 3-track disc mounted */
function makeCd() {
	const pump = new Pump();
	const cd = new CDROM(pump, () => {});
	cd.write8(0, 1);
	cd.write8(2, 0x1f);
	cd.write8(0, 0);
	cd.insert(new ArrayBuffer(2352 * 400), true, [
		{number: 1, startLba: 0, audio: false},
		{number: 2, startLba: 250, audio: true},
		{number: 3, startLba: 320, audio: true},
	]);
	return {cd, pump};
}

function ack(cd) {
	cd.write8(0, 1);
	cd.write8(3, 0x1f);
	cd.write8(0, 0);
}

function resp(cd) {
	return cd.read8(1);
}

describe("multi-track CDROM", () => {
	it("GetTN reports the full track range", () => {
		const {cd, pump} = makeCd();
		cd.write8(1, 0x13);
		pump.run(100000);
		expect(resp(cd)).toBe(cd.stat);
		expect(resp(cd)).toBe(0x01);
		expect(resp(cd)).toBe(0x03);
	});

	it("GetTD returns track starts and the lead-out", () => {
		const {cd, pump} = makeCd();
		cd.write8(2, 0x02);   // track 2
		cd.write8(1, 0x14);
		pump.run(100000);
		resp(cd);
		// track 2 at LBA 250 -> +150 = 400 sectors = 00:05:25 -> mm=0, ss=5
		expect(resp(cd)).toBe(0x00);
		expect(resp(cd)).toBe(0x05);
		ack(cd);

		cd.write8(2, 0x00);   // lead-out
		cd.write8(1, 0x14);
		pump.run(100000);
		resp(cd);
		// 400 sectors total -> +150 = 550 = 00:07:25
		expect(resp(cd)).toBe(0x00);
		expect(resp(cd)).toBe(0x07);
	});

	it("Play starts CDDA and GetlocP tracks the position", () => {
		const {cd, pump} = makeCd();
		cd.write8(2, 0x02);   // play track 2
		cd.write8(1, 0x03);
		pump.run(100000);
		expect(cd.stat & 0x80).toBe(0x80); // playing
		ack(cd);

		pump.run(33868800 / 2); // half a second ~ 37 sectors, still in track 2
		expect(cd.playLba).toBeGreaterThanOrEqual(250 + 30);
		expect(cd.playLba).toBeLessThan(320);

		cd.write8(1, 0x11);   // GetlocP
		pump.run(100000);
		expect(resp(cd)).toBe(0x02); // track number BCD
	});

	it("autopauses with INT4 at the end of a track", () => {
		const {cd, pump} = makeCd();
		cd.write8(0, 0);
		cd.write8(2, 0x02);   // Setmode: autopause
		cd.write8(1, 0x0e);
		pump.run(100000);
		ack(cd);
		cd.write8(2, 0x03);   // play last track (320..400 = 80 sectors)
		cd.write8(1, 0x03);
		pump.run(100000);
		ack(cd);
		pump.run(33868800 * 2); // 2 seconds > 80 sectors
		expect(cd.stat & 0x80).toBe(0);   // stopped playing
		cd.write8(0, 1);
		expect(cd.read8(3) & 0x7).toBe(4); // INT4 pending
	});

	it("Pause stops playback", () => {
		const {cd, pump} = makeCd();
		cd.write8(2, 0x02);
		cd.write8(1, 0x03);
		pump.run(100000);
		ack(cd);
		cd.write8(1, 0x09);
		pump.run(200000);
		expect(cd.playing).toBe(false);
		expect(cd.stat & 0x80).toBe(0);
	});
});
