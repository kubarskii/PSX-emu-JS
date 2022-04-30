import {instruction as i} from "../../src/cpu/instruction";

describe("Instruction tests", () => {
	it("should create instruction functional object", () => {
		const instruction = i(0x0b001111);
		expect(instruction).toBeTruthy();
	});

	it("should get Immediate value (imm) from instruction", () => {
		/**
         * imm is first 16 bits in MIPS instruction
         * */
		const instruction = i(0x0b001111);
		const imm = instruction.imm();
		expect(imm).toBeTruthy();
		expect(imm).toBe(0x1111);
	});

	it("should get opcode from instruction", () => {
		const instruction = i(0x0b001111);
		/**
         * opcode is last 6 bits
         * we move right 26 bits (32 - 6)
         * instruction 00001011000000000001000100010001
         * 000010 is opcode or 0x2
         * */
		const opcode = instruction.opcode();
		expect(opcode).toBeTruthy();
		expect(opcode).toBe(0x2);
	});

	it("should get register rt id from instruction", () => {
		const instruction = i(0x0b001111);
		/**
         * it should be 00000
         * */
		const rt = instruction.rt();
		expect(rt).toBe(0x0);
	});

	it("should get register rs from instruction", () => {
		const instruction = i(0x12345678);
		// 10001
		const rs = instruction.rs();
		expect(rs).toBe(0x11);
	});

	it("should get address from instruction", () => {
		const instruction = i(0x12345678);
		const address = instruction.address();
		expect(address).toBe(0x2345678);
	});

	it("should get Register rd from instruction", () => {
		const instruction = i(0x12345678);
		const rd = instruction.rd();
		expect(rd).toBe(0xa);
	});

	it("should get shamt from instruction", () => {
		const instruction = i(0x12345678);
		const shamt = instruction.shamt();
		expect(shamt).toBe(0x19);
	});

	it("should get funct from instruction", () => {
		const instruction = i(0x12345678);
		const shamt = instruction.funct();
		expect(shamt).toBe(0x38);
	});

});
