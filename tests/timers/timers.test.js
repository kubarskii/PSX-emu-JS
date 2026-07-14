import {Timers} from "../../src/timers/timers";

describe("Timers", () => {
	let timers, irqs;
	beforeEach(() => {
		irqs = [];
		timers = new Timers((bit) => irqs.push(bit));
	});

	it("counts sysclock cycles", () => {
		timers.write(0x24, 0);        // timer2 mode: free run, sysclock
		timers.advance(100, 1, false);
		expect(timers.read(0x20)).toBe(100);
	});

	it("fires IRQ and resets at the target", () => {
		timers.write(0x28, 50);                // timer2 target
		timers.write(0x24, (1 << 3) | (1 << 4) | (1 << 6)); // reset@target, irq@target, repeat
		timers.advance(60, 1, false);
		expect(irqs).toEqual([6]);
		expect(timers.read(0x20)).toBe(60 % 51);
		expect((timers.read(0x24) >> 11) & 1).toBe(1);   // reached target
		expect((timers.read(0x24) >> 11) & 1).toBe(0);   // cleared on read
	});

	it("fires a single IRQ in one-shot mode", () => {
		timers.write(0x28, 10);
		timers.write(0x24, (1 << 3) | (1 << 4)); // no repeat bit
		timers.advance(100, 1, false);
		timers.advance(100, 1, false);
		expect(irqs).toEqual([6]);
	});

	it("wraps at 0xffff and flags the overflow", () => {
		timers.write(0x24, 1 << 5); // irq at max
		timers.write(0x20, 0xfff0);
		timers.advance(0x20, 1, false);
		expect(irqs).toEqual([6]);
		expect(timers.read(0x20)).toBe(0x10);
	});

	it("timer1 counts hblanks when selected", () => {
		timers.write(0x14, 1 << 8); // source: hblank
		timers.advance(2000, 1, false);
		timers.advance(2000, 1, false);
		expect(timers.read(0x10)).toBe(2);
	});

	it("timer0 counts dotclock (sysclk * 11 / 7 / divider)", () => {
		timers.dotDivider = 8;
		timers.write(0x04, 1 << 8); // source: dotclock
		timers.advance(56, 1, false); // 56 * 11 / 56 = 11 dots
		expect(timers.read(0x00)).toBe(11);
	});

	it("timer2 sync mode 0 stops the counter", () => {
		timers.write(0x24, 1); // sync enable, mode 0
		timers.advance(100, 1, false);
		expect(timers.read(0x20)).toBe(0);
	});
});
