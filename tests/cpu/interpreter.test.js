import {makeCpu, stepN, BASE} from "../harness";
import {EXC} from "../../src/cpu/cpu";
import * as A from "../asm";

const EXC_HANDLER = 0x80000080;

describe("ALU", () => {
	it("ADDIU adds a sign-extended (negative) immediate", () => {
		const {cpu} = makeCpu([A.ADDIU(1, 0, 10), A.ADDIU(2, 1, -3)]);
		stepN(cpu, 2);
		expect(cpu.regs[2]).toBe(7);
	});

	it("ADDIU wraps around without trapping", () => {
		const {cpu} = makeCpu([A.LUI(1, 0x7fff), A.ORI(1, 1, 0xffff), A.ADDIU(2, 1, 1)]);
		stepN(cpu, 3);
		expect(cpu.regs[2]).toBe(-0x80000000);
	});

	it("ADDI traps on signed overflow and leaves rt untouched", () => {
		const {cpu} = makeCpu([A.LUI(1, 0x7fff), A.ORI(1, 1, 0xffff), A.ADDI(2, 1, 1)]);
		cpu.regs[2] = 42;
		stepN(cpu, 3);
		expect(cpu.regs[2]).toBe(42);
		expect(cpu.pc >>> 0).toBe(EXC_HANDLER);
		expect((cpu.cause >>> 2) & 0x1f).toBe(EXC.OVERFLOW);
		expect(cpu.epc >>> 0).toBe(BASE + 8);
	});

	it("ANDI/ORI/XORI zero-extend the immediate", () => {
		const {cpu} = makeCpu([
			A.ADDIU(1, 0, -1),        // r1 = 0xffffffff
			A.ANDI(2, 1, 0x8000),     // r2 = 0x00008000
			A.ORI(3, 0, 0x8000),      // r3 = 0x00008000
			A.XORI(4, 1, 0x8000),     // r4 = 0xffff7fff
		]);
		stepN(cpu, 4);
		expect(cpu.regs[2] >>> 0).toBe(0x8000);
		expect(cpu.regs[3] >>> 0).toBe(0x8000);
		expect(cpu.regs[4] >>> 0).toBe(0xffff7fff);
	});

	it("SLT family follows signed/unsigned semantics", () => {
		const {cpu} = makeCpu([
			A.ADDIU(1, 0, -1),
			A.ADDIU(2, 0, 1),
			A.SLT(3, 1, 2),           // -1 < 1 (signed) = 1
			A.SLTU(4, 1, 2),          // 0xffffffff < 1 (unsigned) = 0
			A.SLTI(5, 1, 0),          // -1 < 0 = 1
			A.SLTIU(6, 2, -1),        // 1 < 0xffffffff = 1
		]);
		stepN(cpu, 6);
		expect(cpu.regs[3]).toBe(1);
		expect(cpu.regs[4]).toBe(0);
		expect(cpu.regs[5]).toBe(1);
		expect(cpu.regs[6]).toBe(1);
	});

	it("writes to r0 are discarded", () => {
		const {cpu} = makeCpu([A.ADDIU(0, 0, 123), A.ADDU(1, 0, 0)]);
		stepN(cpu, 2);
		expect(cpu.regs[0]).toBe(0);
		expect(cpu.regs[1]).toBe(0);
	});
});

describe("shifts", () => {
	it("SLL/SRL/SRA handle sign correctly", () => {
		const {cpu} = makeCpu([
			A.ADDIU(1, 0, -8),        // 0xfffffff8
			A.SLL(2, 1, 4),
			A.SRL(3, 1, 4),
			A.SRA(4, 1, 4),
		]);
		stepN(cpu, 4);
		expect(cpu.regs[2]).toBe(-128);
		expect(cpu.regs[3] >>> 0).toBe(0x0fffffff);
		expect(cpu.regs[4]).toBe(-1);
	});

	it("variable shifts mask the amount to 5 bits", () => {
		const {cpu} = makeCpu([
			A.ADDIU(1, 0, 1),
			A.ADDIU(2, 0, 33),        // shift amount 33 -> 1
			A.SLLV(3, 1, 2),
		]);
		stepN(cpu, 3);
		expect(cpu.regs[3]).toBe(2);
	});
});

describe("multiply/divide", () => {
	it("MULT produces a signed 64bit result in hi:lo", () => {
		const {cpu} = makeCpu([A.ADDIU(1, 0, -3), A.ADDIU(2, 0, 7), A.MULT(1, 2), A.MFHI(3), A.MFLO(4)]);
		stepN(cpu, 5);
		expect(cpu.regs[3]).toBe(-1);
		expect(cpu.regs[4]).toBe(-21);
	});

	it("MULT matches BigInt reference on large operands", () => {
		const a = 0x12345678 | 0;
		const b = 0x9abcdef0 | 0;
		const {cpu} = makeCpu([
			A.LUI(1, 0x1234), A.ORI(1, 1, 0x5678),
			A.LUI(2, 0x9abc), A.ORI(2, 2, 0xdef0),
			A.MULT(1, 2),
		]);
		stepN(cpu, 5);
		const ref = BigInt(a) * BigInt(b);
		expect(cpu.lo >>> 0).toBe(Number(ref & 0xffffffffn));
		expect(cpu.hi >>> 0).toBe(Number((ref >> 32n) & 0xffffffffn));
	});

	it("MULTU matches BigInt reference on max operands", () => {
		const {cpu} = makeCpu([
			A.ADDIU(1, 0, -1), A.ADDIU(2, 0, -1),
			A.MULTU(1, 2),
		]);
		stepN(cpu, 3);
		const ref = 0xffffffffn * 0xffffffffn;
		expect(cpu.lo >>> 0).toBe(Number(ref & 0xffffffffn));
		expect(cpu.hi >>> 0).toBe(Number((ref >> 32n) & 0xffffffffn));
	});

	it("DIV handles quotient/remainder and special cases", () => {
		const {cpu} = makeCpu([A.ADDIU(1, 0, 7), A.ADDIU(2, 0, -2), A.DIV(1, 2)]);
		stepN(cpu, 3);
		expect(cpu.lo).toBe(-3);
		expect(cpu.hi).toBe(1);
	});

	it("DIV by zero follows MIPS convention", () => {
		const {cpu} = makeCpu([A.ADDIU(1, 0, 5), A.DIV(1, 0)]);
		stepN(cpu, 2);
		expect(cpu.lo).toBe(-1);
		expect(cpu.hi).toBe(5);

		const {cpu: cpu2} = makeCpu([A.ADDIU(1, 0, -5), A.DIV(1, 0)]);
		stepN(cpu2, 2);
		expect(cpu2.lo).toBe(1);
		expect(cpu2.hi).toBe(-5);
	});

	it("DIV INT_MIN by -1 saturates", () => {
		const {cpu} = makeCpu([A.LUI(1, 0x8000), A.ADDIU(2, 0, -1), A.DIV(1, 2)]);
		stepN(cpu, 3);
		expect(cpu.lo).toBe(-0x80000000);
		expect(cpu.hi).toBe(0);
	});

	it("DIVU treats operands as unsigned", () => {
		const {cpu} = makeCpu([A.ADDIU(1, 0, -1), A.ADDIU(2, 0, 2), A.DIVU(1, 2)]);
		stepN(cpu, 3);
		expect(cpu.lo >>> 0).toBe(0x7fffffff);
		expect(cpu.hi).toBe(1);
	});
});

describe("branches and jumps", () => {
	it("executes the delay slot of a taken branch", () => {
		const {cpu} = makeCpu([
			A.BEQ(0, 0, 2),           // taken, target = +4+8
			A.ADDIU(1, 0, 1),         // delay slot: executes
			A.ADDIU(2, 0, 1),         // skipped
			A.ADDIU(3, 0, 1),         // target
		]);
		stepN(cpu, 3);
		expect(cpu.regs[1]).toBe(1);
		expect(cpu.regs[2]).toBe(0);
		expect(cpu.regs[3]).toBe(1);
	});

	it("JAL links to the instruction after the delay slot", () => {
		const {cpu} = makeCpu([A.JAL(BASE + 16), A.NOP]);
		stepN(cpu, 2);
		expect(cpu.regs[31] >>> 0).toBe(BASE + 8);
		expect(cpu.pc >>> 0).toBe(BASE + 16);
	});

	it("JR returns through a register", () => {
		const {cpu} = makeCpu([
			A.ADDIU(1, 0, 0x100),
			A.LUI(2, 0x8000), A.OR(1, 1, 2), // r1 = 0x80000100
			A.JR(1), A.NOP,
		]);
		stepN(cpu, 5);
		expect(cpu.pc >>> 0).toBe(0x80000100);
	});

	it("BLTZAL always links, branches conditionally", () => {
		const {cpu} = makeCpu([A.ADDIU(1, 0, 5), A.BLTZAL(1, 4), A.NOP]);
		stepN(cpu, 3);
		expect(cpu.regs[31] >>> 0).toBe(BASE + 12); // linked despite not taken
		expect(cpu.pc >>> 0).toBe(BASE + 12);       // fell through
	});
});

describe("memory access", () => {
	it("LB sign-extends, LBU zero-extends", () => {
		const {cpu, mem} = makeCpu([
			A.LUI(1, 0x8000),         // r1 = 0x80000000 (RAM)
			A.LB(2, 0, 1), A.NOP,
			A.LBU(3, 0, 1), A.NOP,
		]);
		mem.write8(0x80000000, 0x80);
		stepN(cpu, 5);
		expect(cpu.regs[2]).toBe(-128);
		expect(cpu.regs[3]).toBe(0x80);
	});

	it("SB/SH/SW hit the right byte lanes (little endian)", () => {
		const {cpu, mem} = makeCpu([
			A.LUI(1, 0x8000),
			A.ADDIU(2, 0, 0x11),
			A.SB(2, 1, 1),            // byte at +1
			A.ADDIU(3, 0, 0x2233 - 0x10000), // sign-irrelevant 16bit pattern
			A.SH(3, 2, 1),            // half at +2
		]);
		stepN(cpu, 5);
		expect(mem.read32(0x80000000) >>> 0).toBe(0x22330000 | 0x1100);
	});

	it("load delay slot: the next instruction still sees the old value", () => {
		const {cpu, mem} = makeCpu([
			A.LUI(1, 0x8000),
			A.LW(2, 0, 1),            // r2 <- mem (delayed)
			A.ADDU(3, 2, 0),          // sees OLD r2
			A.ADDU(4, 2, 0),          // sees NEW r2
		]);
		mem.write32(0x80000000, 1234);
		cpu.regs[2] = 55;
		stepN(cpu, 4);
		expect(cpu.regs[3]).toBe(55);
		expect(cpu.regs[4]).toBe(1234);
	});

	it("a write in the delay slot wins over the delayed load", () => {
		const {cpu, mem} = makeCpu([
			A.LUI(1, 0x8000),
			A.LW(2, 0, 1),
			A.ADDIU(2, 0, 5),         // overwrites the load target
			A.NOP,
		]);
		mem.write32(0x80000000, 1234);
		stepN(cpu, 4);
		expect(cpu.regs[2]).toBe(5);
	});

	it("LWL/LWR pair assembles an unaligned word", () => {
		const {cpu, mem} = makeCpu([
			A.LUI(1, 0x8000),
			A.LWR(2, 1, 1),           // low part from 0x80000001
			A.LWL(2, 4, 1),           // high part up to 0x80000004
			A.NOP,
		]);
		mem.write32(0x80000000, 0x44332211);
		mem.write32(0x80000004, 0x88776655);
		stepN(cpu, 4);
		expect(cpu.regs[2] >>> 0).toBe(0x55443322);
	});

	it("SWL/SWR pair stores an unaligned word", () => {
		const {cpu, mem} = makeCpu([
			A.LUI(1, 0x8000),
			A.LUI(2, 0xaabb), A.ORI(2, 2, 0xccdd),
			A.SWR(2, 1, 1),
			A.SWL(2, 4, 1),
		]);
		mem.write32(0x80000000, 0x44332211 | 0);
		mem.write32(0x80000004, 0x88776655 | 0);
		stepN(cpu, 5);
		expect(mem.read32(0x80000000) >>> 0).toBe(0xbbccdd11);
		expect(mem.read32(0x80000004) >>> 0).toBe(0x887766aa);
	});

	it("stores are ignored while the cache is isolated (SR.IsC)", () => {
		const {cpu, mem} = makeCpu([
			A.LUI(1, 0x8000),
			A.ADDIU(2, 0, 77),
			A.SW(2, 0x10, 1),
		]);
		cpu.sr = 0x10000;
		stepN(cpu, 3);
		expect(mem.read32(0x80000010)).toBe(0);
	});

	it("misaligned LW raises an address error with BadVaddr", () => {
		const {cpu} = makeCpu([A.LUI(1, 0x8000), A.LW(2, 1, 1)]);
		stepN(cpu, 2);
		expect(cpu.pc >>> 0).toBe(EXC_HANDLER);
		expect((cpu.cause >>> 2) & 0x1f).toBe(EXC.ADDR_LOAD);
		expect(cpu.badVaddr >>> 0).toBe(0x80000001);
	});
});

describe("exceptions and COP0", () => {
	it("SYSCALL vectors to the handler and RFE returns", () => {
		const {cpu} = makeCpu([A.ADDIU(1, 0, 1), A.SYSCALL()]);
		cpu.sr = 0x1; // interrupts enabled: pushed on the mode stack
		stepN(cpu, 2);
		expect(cpu.pc >>> 0).toBe(EXC_HANDLER);
		expect((cpu.cause >>> 2) & 0x1f).toBe(EXC.SYSCALL);
		expect(cpu.epc >>> 0).toBe(BASE + 4);
		expect(cpu.sr & 0x3f).toBe(0x4); // IEc pushed to IEp

		// hand-rolled RFE at the handler
		cpu.executeInstr(A.RFE());
		expect(cpu.sr & 0x3f).toBe(0x1);
	});

	it("an exception in a branch delay slot sets BD and rewinds EPC", () => {
		const {cpu} = makeCpu([
			A.BEQ(0, 0, 4),
			A.SYSCALL(),              // delay slot
		]);
		stepN(cpu, 2);
		expect(cpu.epc >>> 0).toBe(BASE); // points at the branch
		expect(cpu.cause < 0).toBe(true); // BD bit (31) set
	});

	it("MFC0 reads SR with a load delay", () => {
		const {cpu} = makeCpu([A.MFC0(1, 12), A.ADDU(2, 1, 0), A.ADDU(3, 1, 0)]);
		cpu.sr = 0x12345678;
		cpu.regs[1] = 7;
		stepN(cpu, 3);
		expect(cpu.regs[2]).toBe(7);           // old value in the delay slot
		expect(cpu.regs[3]).toBe(0x12345678);  // delayed value after
	});

	it("takes a hardware interrupt when unmasked", () => {
		const {cpu, mem} = makeCpu([A.NOP, A.NOP, A.NOP]);
		cpu.sr = 0x401; // IEc | IM2 (hardware irq line)
		mem.iMask = 0x1;
		mem.raiseIrq(0); // VBlank
		stepN(cpu, 1);
		expect(cpu.pc >>> 0).toBe(EXC_HANDLER + 4); // handler entered, 1 instr done
		expect((cpu.cause >>> 2) & 0x1f).toBe(EXC.INTERRUPT);
		expect((cpu.cause & 0x400) !== 0).toBe(true);
	});

	it("illegal instructions raise a reserved-instruction exception", () => {
		const {cpu} = makeCpu([0x3f << 26]);
		stepN(cpu, 1);
		expect(cpu.pc >>> 0).toBe(EXC_HANDLER);
		expect((cpu.cause >>> 2) & 0x1f).toBe(EXC.ILLEGAL);
	});
});
