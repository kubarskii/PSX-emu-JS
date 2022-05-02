import {memory} from "../../memory";

export const MA = {
	SW(i) {
		const imm = i.imm();
		const rt = i.rt();
		const rs = i.rs();
		const addr = this.getReg(rs) + imm >>> 0;

		memory.memWrite(addr, this.getReg(rt));
	}
};

