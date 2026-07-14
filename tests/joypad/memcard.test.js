import {Joypad} from "../../src/joypad/joypad";

/** @return {{pad: Joypad, pump: () => void}} */
function makePad() {
	const events = [];
	const pad = new Joypad((c, fn) => events.push(fn), () => {});
	const pump = () => {
		while (events.length > 0) events.shift()();
	};
	pad.write(0xa, 0x1003); // select slot 1, tx enable, ack irq enable
	return {pad, pump};
}

/** @return {number} - reply byte */
function xfer(pad, pump, v) {
	pad.write(0x0, v);
	pump();
	return pad.read(0x0, 1);
}

/** ends the exchange like real software does (deselect) */
function deselect(pad) {
	pad.write(0xa, 0x0);
	pad.write(0xa, 0x1003);
}

/**
 * Reads one sector through the full SIO protocol.
 * @return {{data: number[], chk: number, status: number}}
 */
function readSector(pad, pump, sector) {
	xfer(pad, pump, 0x81);                       // address the card
	xfer(pad, pump, 0x52);                       // read command -> FLAG
	xfer(pad, pump, 0x00);                       // -> 5a
	xfer(pad, pump, 0x00);                       // -> 5d
	xfer(pad, pump, (sector >> 8) & 0xff);
	xfer(pad, pump, sector & 0xff);
	xfer(pad, pump, 0x00);                       // -> 5c
	xfer(pad, pump, 0x00);                       // -> 5d
	xfer(pad, pump, 0x00);                       // -> msb
	xfer(pad, pump, 0x00);                       // -> lsb
	const data = [];
	for (let i = 0; i < 128; i++) data.push(xfer(pad, pump, 0x00));
	const chk = xfer(pad, pump, 0x00);
	const status = xfer(pad, pump, 0x00);
	deselect(pad);
	return {data, chk, status};
}

/**
 * Writes one sector through the full SIO protocol.
 * @return {number} - end status byte
 */
function writeSector(pad, pump, sector, bytes, chkOverride) {
	xfer(pad, pump, 0x81);
	xfer(pad, pump, 0x57);
	xfer(pad, pump, 0x00);
	xfer(pad, pump, 0x00);
	xfer(pad, pump, (sector >> 8) & 0xff);
	xfer(pad, pump, sector & 0xff);
	let chk = ((sector >> 8) & 0xff) ^ (sector & 0xff);
	for (const b of bytes) {
		xfer(pad, pump, b);
		chk ^= b;
	}
	xfer(pad, pump, chkOverride !== undefined ? chkOverride : chk);
	xfer(pad, pump, 0x00); // -> 5c
	xfer(pad, pump, 0x00); // -> 5d
	const status = xfer(pad, pump, 0x00);
	deselect(pad);
	return status;
}

describe("Memory card", () => {
	it("answers the get-ID command", () => {
		const {pad, pump} = makePad();
		xfer(pad, pump, 0x81);
		xfer(pad, pump, 0x53);
		expect(xfer(pad, pump, 0x00)).toBe(0x5a);
		expect(xfer(pad, pump, 0x00)).toBe(0x5d);
		expect(xfer(pad, pump, 0x00)).toBe(0x5c);
		expect(xfer(pad, pump, 0x00)).toBe(0x5d);
		expect(xfer(pad, pump, 0x00)).toBe(0x04);
		expect(xfer(pad, pump, 0x00)).toBe(0x00);
		expect(xfer(pad, pump, 0x00)).toBe(0x00);
		expect(xfer(pad, pump, 0x00)).toBe(0x80);
	});

	it("reads the formatted header sector", () => {
		const {pad, pump} = makePad();
		const r = readSector(pad, pump, 0);
		expect(r.status).toBe(0x47);
		expect(r.data[0]).toBe(0x4d); // 'M'
		expect(r.data[1]).toBe(0x43); // 'C'
		let x = 0;
		for (const b of r.data) x ^= b;
		expect(r.chk).toBe(x); // checksum covers addr ^ data; addr 0 here
	});

	it("writes a sector and reads it back", () => {
		const {pad, pump} = makePad();
		let saved = 0;
		pad.card.onWrite = () => saved++;
		const bytes = Array.from({length: 128}, (_, i) => (i * 7) & 0xff);
		const status = writeSector(pad, pump, 66, bytes);
		expect(status).toBe(0x47);
		expect(saved).toBe(1);
		const r = readSector(pad, pump, 66);
		expect(r.data).toEqual(bytes);
	});

	it("rejects a write with a bad checksum", () => {
		const {pad, pump} = makePad();
		const before = pad.card.data[10 * 128];
		const status = writeSector(pad, pump, 10, new Array(128).fill(0x55), 0x00);
		expect(status).toBe(0xff);
		expect(pad.card.data[10 * 128]).toBe(before); // unchanged
	});

	it("clears the fresh flag after a completed read", () => {
		const {pad, pump} = makePad();
		expect(pad.card.flag & 0x08).toBe(0x08);
		readSector(pad, pump, 0);
		expect(pad.card.flag & 0x08).toBe(0);
	});

	it("loads a persisted image", () => {
		const {pad, pump} = makePad();
		const img = new Uint8Array(128 * 1024);
		img[128 * 3] = 0xab;
		pad.card.load(img);
		const r = readSector(pad, pump, 3);
		expect(r.data[0]).toBe(0xab);
	});

	it("does not break the controller exchange", () => {
		const {pad, pump} = makePad();
		readSector(pad, pump, 0);
		xfer(pad, pump, 0x01);
		expect(xfer(pad, pump, 0x42)).toBe(0x41); // pad still answers
	});
});
