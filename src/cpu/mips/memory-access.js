import {memory} from "../../memory";
import {getSigned16} from "../../utils";

export const MA = {
	SW(i) {
		if ((this._sr & 0x1000) !== 0x0) {
			console.log("Ignoring write as cache is isolated!");
			return;
		}
		const imm = getSigned16(i.imm());
		const rt = i.rt();
		const rs = i.rs();
		const addr = this.getRegV(rs) + imm >>> 0;
		console.log(`0x${this._currentPc.toString(16).padStart(8, 0)}: ${i}: sw     r${rt}, $${imm.toString(16).padStart(4, 0)}(r${rs})`);
		memory.memWrite(addr, this.getRegV(rt));
	},

	LW(i){
		const rs = i.rs();
		const rt = i.rt();
		const offset = i.imm();

		console.log(rs, rt, offset);

	},

	// SB(i) {
	//
	// },

	// SH(i) {
	//
	// }
};

