import {Joypad, BUTTONS} from "../../src/joypad/joypad";

/** @return {{pad: Joypad, irqs: number[], pump: () => void}} */
function makePad() {
	const events = [];
	const irqs = [];
	const pad = new Joypad((c, fn) => events.push(fn), (bit) => irqs.push(bit));
	const pump = () => {
		while (events.length > 0) events.shift()();
	};
	// select pad, enable tx + ack interrupt
	pad.write(0xa, 0x1003 | 0x2);
	return {pad, irqs, pump};
}

/** @return {number} - reply to one exchanged byte */
function xfer(pad, pump, v) {
	pad.write(0x0, v);
	pump();
	return pad.read(0x0, 1);
}

describe("Joypad (SIO0)", () => {
	it("answers the digital pad discovery sequence", () => {
		const {pad, pump} = makePad();
		xfer(pad, pump, 0x01);                       // address the pad
		expect(xfer(pad, pump, 0x42)).toBe(0x41);    // digital pad id
		expect(xfer(pad, pump, 0x00)).toBe(0x5a);
		expect(xfer(pad, pump, 0x00)).toBe(0xff);    // buttons low (none pressed)
		expect(xfer(pad, pump, 0x00)).toBe(0xff);    // buttons high
	});

	it("reflects pressed buttons (active low)", () => {
		const {pad, pump} = makePad();
		pad.press(BUTTONS.START | BUTTONS.CROSS);
		xfer(pad, pump, 0x01);
		xfer(pad, pump, 0x42);
		xfer(pad, pump, 0x00);
		expect(xfer(pad, pump, 0x00)).toBe(0xff & ~0x08); // START in low byte
		expect(xfer(pad, pump, 0x00)).toBe(0xff & ~0x40); // CROSS in high byte
		pad.release(BUTTONS.START | BUTTONS.CROSS);
	});

	it("raises IRQ7 acks between bytes", () => {
		const {pad, irqs, pump} = makePad();
		xfer(pad, pump, 0x01);
		xfer(pad, pump, 0x42);
		expect(irqs.filter((b) => b === 7).length).toBeGreaterThanOrEqual(2);
	});

	it("slot 2 responds as absent", () => {
		const {pad, pump} = makePad();
		pad.write(0xa, 0x2003); // slot 2 selected
		expect(xfer(pad, pump, 0x01)).toBe(0xff);
		expect(xfer(pad, pump, 0x42)).toBe(0xff);
	});
});
