import {DEFAULT_BIOS_PC} from "../utils/constants";

export class BIOS {
    cpu;
    memory;

    /**
     * @param {CPU} cpu
     * @param {Uint32Array} memory
     * */
    constructor(cpu, memory) {
        this.cpu = cpu;
        this.memory = memory;
    }

    run() {
        this.cpu.pc = DEFAULT_BIOS_PC;

        /**
         *  hook the Kernel after BIOS initialization
         *
         *  you can read more here:
         *  https://psx-spx.consoledev.net/expansionportpio/#mid-boot-hook
         * */
        const BIOS_END = 0x80030000;
        debugger
        let k = 0
        while (k < 10/*this.cpu.registers.pc !== BIOS_END*/) {
            const pc = this.cpu.pc;
            const operationInMemoryId = (~DEFAULT_BIOS_PC) & pc;
            const operation = this.memory[operationInMemoryId];
            this.cpu.execute(operation);
            k++
        }
    }
}
