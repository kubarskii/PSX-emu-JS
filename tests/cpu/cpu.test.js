import {CPU} from "../../src/cpu/cpu";

describe("CPU tests", () => {
	it("should create CPU", () => {
		const cpu = new CPU();
		expect(cpu).toBeTruthy();
	});

	it("should set register value by register ID", () => {
		const cpu = new CPU();
		cpu.setRegV(0x1, 10);
		expect(cpu.getRegV(0x1)).toBe(10);
	});

	it("should NOT update ZERO register", () => {
		const cpu = new CPU();
		cpu.setRegV(0x0, 20);
		expect(cpu.getRegV(0x0)).toBe(0x0);
	});
});
