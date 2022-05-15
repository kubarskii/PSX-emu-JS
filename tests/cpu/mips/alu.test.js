import {CPU} from "../../../src/cpu/cpu";
import {instruction as i} from "../../../src/cpu/instruction";

describe("ALU CPU tests", () => {
	it("should run ALU LUI instruction", () => {
		const cpu = new CPU();
		const instruction = i(0x3c080f13);
		cpu.alu.LUI(instruction);
		expect(cpu.getRegV(0x8)).toBe(0xf13 << 16);
	});

	it("should run ALU ORI instruction", () => {
		const cpu = new CPU();
		const instruction = i(0x3c080013);
		const instruction2 = i(0x3508243f);
		cpu.alu.LUI(instruction);
		cpu.alu.ORI(instruction2);
		expect(cpu.getRegV(0x8)).toBe(0x0013243f);
	});
});
