import {makeCpu, stepN} from "./harness";
import * as A from "./asm";

it("bench: interpreter vs block cache", () => {
	const p = [
		A.ADDIU(1, 0, 30000),
		A.ADDU(2, 2, 1),
		A.ADDIU(1, 1, -1),
		A.XOR(3, 2, 1),
		A.SLT(4, 3, 2),
		A.BGTZ(1, -5),
		A.NOP,
		A.J(0x80001000),
		A.NOP,
	];
	const N = 8_000_000;

	const a = makeCpu(p);
	let t0 = performance.now();
	stepN(a.cpu, N);
	const tInterp = performance.now() - t0;

	const b = makeCpu(p);
	b.blocks.run(1000); // warmup + compile
	t0 = performance.now();
	b.blocks.run(N);
	const tBlocks = performance.now() - t0;

	const mipsInterp = (N / 1e6) / (tInterp / 1000);
	const mipsBlocks = (N / 1e6) / (tBlocks / 1000);
	console.log(`interpreter: ${mipsInterp.toFixed(1)} Minstr/s, blocks: ${mipsBlocks.toFixed(1)} Minstr/s, speedup x${(mipsBlocks / mipsInterp).toFixed(1)}`);
}, 120000);
