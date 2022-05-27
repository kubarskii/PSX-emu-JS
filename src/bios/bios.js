import {memory} from "../memory";

export class BIOS {
	cpu;
	memory;

	/**
     * @param {CPU} cpu
     * @param {Mapping} memory
     * */
	constructor(cpu, memory) {
		this.cpu = cpu;
		this.memory = memory;
	}

	run() {
		/**
         *  hook the Kernel after BIOS initialization
         *
         *  you can read more here:
         *  https://psx-spx.consoledev.net/expansionportpio/#mid-boot-hook
         * */
		const BIOS_END = 0x80030000;
		while ((this.cpu.pc | 0) !== (BIOS_END | 0)) {
			this.cpu.execute();
		}
		console.log(memory, this.cpu.regs);
	}
}

