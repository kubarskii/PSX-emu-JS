import {CPU} from "../../src/cpu/cpu";
import {instruction as i} from "../../src/cpu/instruction";

describe("CPU tests", () => {
	it("should create CPU", () => {
		const cpu = new CPU();
		expect(cpu).toBeTruthy();
	});

	it("should set register value by register ID", () => {
		const cpu = new CPU();
		cpu.setReg(0x1, 10);
		expect(cpu.getReg(0x1)).toBe(10);
	});

	it("should NOT update ZERO register", () => {
		const cpu = new CPU();
		cpu.setReg(0x0, 20);
		expect(cpu.getReg(0x0)).toBe(0x0);
	});
});

describe("ALU CPU tests", () => {
	it("should run ALU LUI instruction", () => {
		const cpu = new CPU();
		const instruction = i(0x3c080f13);
		cpu.alu.LUI(instruction);
		expect(cpu.getReg(0x8)).toBe(0xf13 << 16);
	});

	it("should run ALU ORI instruction", () => {
		const cpu = new CPU();
		const instruction = i(0x3c080013);
		const instruction2 = i(0x3508243f);
		cpu.alu.LUI(instruction);
		cpu.alu.ORI(instruction2);
		expect(cpu.getReg(0x8)).toBe(0x0013243f);
	});
});
