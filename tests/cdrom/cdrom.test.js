import {CDROM} from "../../src/cdrom/cdrom";

/** deterministic event pump standing in for the machine scheduler */
class Pump {
	constructor() {
		this.events = [];
		this.schedule = (cycles, fn) => this.events.push({left: cycles, fn, target: null, kind: 0, gen: -1});
		this.scheduleKind = (cycles, target, kind, gen) => {
			this.events.push({left: cycles, fn: null, target, kind, gen});
		};
	}

	/** @param {number} cycles */
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
					due.push(this.events[i]);
					this.events.splice(i, 1);
				}
			}
			for (let i = due.length - 1; i >= 0; i--) {
				const ev = due[i];
				if (ev.target !== null) {
					if (ev.gen < 0 || ev.gen === ev.target.gen) ev.target._onEvent(ev.kind);
				} else {
					ev.fn();
				}
			}
		}
	}
}

/** @return {{cd: CDROM, pump: Pump, irqs: number[]}} */
function makeCd() {
	const pump = new Pump();
	const irqs = [];
	const cd = new CDROM(pump, (bit) => irqs.push(bit));
	cd.write8(0, 1);       // index 1
	cd.write8(2, 0x1f);    // enable all interrupts
	cd.write8(0, 0);       // back to index 0
	return {cd, pump, irqs};
}

/** acknowledges the current interrupt */
function ack(cd) {
	cd.write8(0, 1);
	cd.write8(3, 0x1f);
	cd.write8(0, 0);
}

/** @return {number} - current INT level */
function intLevel(cd) {
	cd.write8(0, 1);
	const v = cd.read8(3) & 0x7;
	cd.write8(0, 0);
	return v;
}

describe("CDROM", () => {
	it("answers the Test(0x20) version command", () => {
		const {cd, pump} = makeCd();
		cd.write8(2, 0x20);   // parameter
		cd.write8(1, 0x19);   // Test
		pump.run(100000);
		expect(intLevel(cd)).toBe(3);
		expect(cd.read8(1)).toBe(0x94);
		expect(cd.read8(1)).toBe(0x09);
	});

	it("GetID without a disc ends in INT5 error", () => {
		const {cd, pump, irqs} = makeCd();
		cd.write8(1, 0x1a);
		pump.run(100000);
		expect(intLevel(cd)).toBe(3);
		ack(cd);
		pump.run(100000);
		expect(intLevel(cd)).toBe(5);
		expect(cd.read8(1)).toBe(0x08);
		expect(cd.read8(1)).toBe(0x40);
		expect(irqs.length).toBeGreaterThanOrEqual(2);
	});

	it("GetID with a disc reports a licensed SCEA disc", () => {
		const {cd, pump} = makeCd();
		cd.insert(new ArrayBuffer(2048 * 16), false);
		cd.write8(1, 0x1a);
		pump.run(100000);
		ack(cd);
		pump.run(100000);
		expect(intLevel(cd)).toBe(2);
		const resp = [];
		for (let i = 0; i < 8; i++) resp.push(cd.read8(1));
		expect(resp.slice(4)).toEqual([0x53, 0x43, 0x45, 0x41]); // "SCEA"
	});

	it("Setloc + ReadN delivers ISO sector data", () => {
		const {cd, pump} = makeCd();
		const image = new Uint8Array(2048 * 16);
		image[2048 * 2] = 0xab; // first byte of LBA 2
		image[2048 * 2 + 1] = 0xcd;
		cd.insert(image.buffer, false);

		// Setloc 00:02:02 -> LBA 2
		cd.write8(2, 0x00);
		cd.write8(2, 0x02);
		cd.write8(2, 0x02);
		cd.write8(1, 0x02);
		pump.run(100000);
		expect(intLevel(cd)).toBe(3);
		ack(cd);

		cd.write8(1, 0x06); // ReadN
		pump.run(100000);
		expect(intLevel(cd)).toBe(3); // command ack
		ack(cd);
		pump.run(600000);   // one sector at single speed
		expect(intLevel(cd)).toBe(1); // data ready
		cd.write8(3, 0x80); // request data fifo
		expect(cd.read8(2)).toBe(0xab);
		expect(cd.read8(2)).toBe(0xcd);

		// stop reading
		ack(cd);
		cd.write8(1, 0x09); // Pause
		pump.run(1000000);
	});

	it("reads BIN images at the mode2/form1 user data offset", () => {
		const {cd, pump} = makeCd();
		const image = new Uint8Array(2352 * 8);
		image[2352 * 3 + 24] = 0x5a; // user data of LBA 3
		cd.insert(image.buffer, true);

		cd.write8(2, 0x00);
		cd.write8(2, 0x02);
		cd.write8(2, 0x03); // 00:02:03 -> LBA 3
		cd.write8(1, 0x02);
		pump.run(100000);
		ack(cd);
		cd.write8(1, 0x06);
		pump.run(100000);
		ack(cd);
		pump.run(600000);
		expect(intLevel(cd)).toBe(1);
		cd.write8(3, 0x80);
		expect(cd.read8(2)).toBe(0x5a);
	});
});
