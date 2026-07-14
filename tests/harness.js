import {Memory} from "../src/memory";
import {CPU} from "../src/cpu/cpu";
import {BlockCache} from "../src/cpu/compiler";

export const BASE = 0x80001000;

/**
 * Builds a CPU with `program` (array of instruction words) placed at
 * `base` and the PC pointing at it.
 * @param {number[]} program
 * @param {number} base
 * @return {{cpu: CPU, mem: Memory, blocks: BlockCache}}
 */
export function makeCpu(program, base = BASE) {
	const mem = new Memory();
	const cpu = new CPU(mem);
	const blocks = new BlockCache(cpu, mem);
	program.forEach((word, k) => mem.write32((base + k * 4) >>> 0, word));
	cpu.pc = base >>> 0;
	cpu.nextPc = (base + 4) >>> 0;
	return {cpu, mem, blocks};
}

/**
 * @param {CPU} cpu
 * @param {number} n - instructions to execute through the interpreter
 */
export function stepN(cpu, n) {
	for (let i = 0; i < n; i++) cpu.step();
}

/**
 * Runs the same program through the interpreter and through the block
 * compiler and asserts identical architectural state.
 * @param {number[]} program - must end in a self-loop (J to itself)
 * @param {number} steps - instructions to execute on each side
 * @param {(cpu: CPU, mem: Memory) => void} [setup]
 */
export function differential(program, steps, setup) {
	const a = makeCpu(program);
	const b = makeCpu(program);
	if (setup) {
		setup(a.cpu, a.mem);
		setup(b.cpu, b.mem);
	}
	stepN(a.cpu, steps);
	b.blocks.run(steps);

	expect(Array.from(b.cpu.regs)).toEqual(Array.from(a.cpu.regs));
	expect(b.cpu.hi | 0).toBe(a.cpu.hi | 0);
	expect(b.cpu.lo | 0).toBe(a.cpu.lo | 0);
	expect(b.cpu.sr | 0).toBe(a.cpu.sr | 0);
	return {interp: a, compiled: b};
}
