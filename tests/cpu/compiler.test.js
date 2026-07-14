import {makeCpu, differential, BASE} from "../harness";
import {PAGE_SHIFT} from "../../src/memory";
import * as A from "../asm";

/** self-loop terminator: parks the PC without touching state */
const HALT = (at) => [A.J(at), A.NOP];

describe("block compiler vs interpreter (differential)", () => {
	it("matches on a straight-line arithmetic mix", () => {
		const p = [
			A.ADDIU(1, 0, -17),
			A.LUI(2, 0x1234), A.ORI(2, 2, 0x5678),
			A.ADDU(3, 1, 2),
			A.SUBU(4, 2, 1),
			A.AND(5, 2, 3), A.OR(6, 2, 3), A.XOR(7, 2, 3), A.NOR(8, 2, 3),
			A.SLT(9, 1, 2), A.SLTU(10, 1, 2),
			A.SLL(11, 2, 7), A.SRA(12, 1, 3), A.SRL(13, 1, 3),
			A.SLLV(14, 2, 9), A.SRAV(15, 1, 10), A.SRLV(16, 1, 10),
			A.SLTI(17, 1, 5), A.SLTIU(18, 1, 5),
			A.ANDI(19, 1, 0xff00), A.ORI(20, 1, 0x00ff), A.XORI(21, 1, 0xffff),
			A.MULT(1, 2), A.MFHI(22), A.MFLO(23),
			A.MULTU(1, 2), A.MFHI(24), A.MFLO(25),
			A.DIV(2, 1), A.MFHI(26), A.MFLO(27),
			A.DIVU(2, 1), A.MFHI(28), A.MFLO(29),
			...HALT(BASE + 34 * 4),
		];
		differential(p, 200);
	});

	it("matches on a counted loop with branches", () => {
		// r2 = sum of 1..100, then halt
		const p = [
			A.ADDIU(1, 0, 100),       // counter
			A.ADDIU(2, 0, 0),         // acc
			// loop:
			A.ADDU(2, 2, 1),          // acc += counter
			A.ADDIU(1, 1, -1),
			A.BGTZ(1, -3),            // back to loop
			A.NOP,
			...HALT(BASE + 6 * 4),
		];
		const {compiled} = differential(p, 1000);
		expect(compiled.cpu.regs[2]).toBe(5050);
	});

	it("matches on loads, stores and load-delay chains", () => {
		const p = [
			A.LUI(1, 0x8000),         // r1 = 0x80000000
			A.ADDIU(2, 0, -12345),
			A.SW(2, 0x40, 1),
			A.SB(2, 0x44, 1),
			A.SH(2, 0x46, 1),
			A.LW(3, 0x40, 1),
			A.ADDU(4, 3, 0),          // delay slot value (old r3)
			A.ADDU(5, 3, 0),          // new r3
			A.LB(6, 0x44, 1), A.NOP,
			A.LBU(7, 0x44, 1), A.NOP,
			A.LH(8, 0x46, 1), A.NOP,
			A.LHU(9, 0x46, 1), A.NOP,
			A.LW(10, 0x40, 1),
			A.ADDIU(10, 0, 9),        // overwrite beats the delayed load
			A.NOP,
			...HALT(BASE + 19 * 4),
		];
		differential(p, 200);
	});

	it("matches on LWL/LWR/SWL/SWR unaligned access", () => {
		const p = [
			A.LUI(1, 0x8000),
			A.LUI(2, 0x1122), A.ORI(2, 2, 0x3344),
			A.SW(2, 0x50, 1),
			A.LUI(3, 0x5566), A.ORI(3, 3, 0x7788),
			A.SW(3, 0x54, 1),
			A.LWR(4, 0x51, 1),
			A.LWL(4, 0x54, 1),
			A.NOP,
			A.SWR(4, 0x59, 1),
			A.SWL(4, 0x5c, 1),
			A.LW(5, 0x58, 1),
			A.LW(6, 0x5c, 1),
			A.NOP,
			...HALT(BASE + 15 * 4),
		];
		differential(p, 200);
	});

	it("matches on jumps with links and register returns", () => {
		const sub = BASE + 0x40; // subroutine address, instruction #16
		const p = [
			A.JAL(sub),               // 0
			A.ADDIU(1, 0, 1),         // 1: delay slot
			A.ADDIU(4, 0, 44),        // 2: after return
			...HALT(BASE + 3 * 4),    // 3,4
			A.NOP, A.NOP, A.NOP, A.NOP, A.NOP, A.NOP, A.NOP, A.NOP, A.NOP, A.NOP, A.NOP, // 5..15
			// sub (16):
			A.ADDIU(2, 0, 22),
			A.JR(31),
			A.ADDIU(3, 0, 33),        // delay slot
		];
		const {compiled} = differential(p, 200);
		expect(compiled.cpu.regs[1]).toBe(1);
		expect(compiled.cpu.regs[2]).toBe(22);
		expect(compiled.cpu.regs[3]).toBe(33);
		expect(compiled.cpu.regs[4]).toBe(44);
	});

	it("matches when a delayed load crosses a block boundary", () => {
		const p = [
			A.LUI(1, 0x8000),
			A.ADDIU(3, 0, 55),
			A.SW(3, 0, 1),
			A.BEQ(0, 0, 1),           // branch to the next instruction
			A.LW(2, 0, 1),            // delay slot: load leaves the block in-flight
			A.ADDU(4, 2, 0),          // next block: still the old r2
			A.ADDU(5, 2, 0),          // now 55
			...HALT(BASE + 7 * 4),
		];
		const {compiled} = differential(p, 100);
		expect(compiled.cpu.regs[4]).toBe(0);
		expect(compiled.cpu.regs[5]).toBe(55);
	});

	it("matches on arithmetic overflow exceptions", () => {
		const p = [
			A.LUI(1, 0x7fff), A.ORI(1, 1, 0xffff),
			A.ADDI(2, 1, 1),          // traps
			...HALT(BASE + 3 * 4),
		];
		const {interp, compiled} = differential(p, 50);
		expect(compiled.cpu.epc >>> 0).toBe(interp.cpu.epc >>> 0);
		expect(compiled.cpu.cause | 0).toBe(interp.cpu.cause | 0);
		expect(compiled.cpu.epc >>> 0).toBe(BASE + 8);
	});

	it("matches on SYSCALL inside a block", () => {
		const p = [
			A.ADDIU(1, 0, 3),
			A.SYSCALL(),
			...HALT(BASE + 2 * 4),
		];
		const {interp, compiled} = differential(p, 50);
		expect(compiled.cpu.epc >>> 0).toBe(interp.cpu.epc >>> 0);
		expect((compiled.cpu.cause >>> 2) & 0x1f).toBe(0x8);
	});
});

describe("block cache invalidation", () => {
	it("recompiles after guest-visible self-modifying code", () => {
		const p = [
			A.ADDIU(2, 2, 1),         // patched later to +5
			A.J(BASE),
			A.NOP,
		];
		const {cpu, mem, blocks} = makeCpu(p);
		blocks.run(60);               // 10 iterations of +1 (budget is in cycles, CPI=2)
		expect(cpu.regs[2]).toBe(10);

		mem.write32(BASE, A.ADDIU(2, 2, 5)); // write through the bus: invalidates
		blocks.run(60);               // 10 iterations of +5
		expect(cpu.regs[2]).toBe(60);
	});

	it("marks RAM pages containing compiled code", () => {
		const p = [A.ADDIU(1, 0, 1), ...HALT(BASE + 4)];
		const {mem, blocks} = makeCpu(p);
		blocks.run(10);
		const page = (BASE & 0x1fffff) >>> PAGE_SHIFT;
		expect(mem.codePages[page]).toBe(1);
		mem.write32(BASE, A.NOP); // differs from the ADDIU there: invalidates
		expect(mem.codePages[page]).toBe(0);
	});
});
