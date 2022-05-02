import {BIOS_POINTER} from "../utils/constants";
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
		this.cpu.pc = BIOS_POINTER;

		/**
         *  hook the Kernel after BIOS initialization
         *
         *  you can read more here:
         *  https://psx-spx.consoledev.net/expansionportpio/#mid-boot-hook
         * */
		const BIOS_END = 0x80030000;
		while (this.cpu.registers.pc !== BIOS_END) {
			const pc = this.cpu.pc;
			const operation = this.memory.memRead(pc);
			this.cpu.execute(operation);
		}
		console.log(memory, this.cpu.registers);
	}
}

