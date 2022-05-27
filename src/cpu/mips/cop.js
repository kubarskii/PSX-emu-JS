import {stubFn} from "../../utils";

export const COP = {

	MTC0(i) {
		const rt = i.rt();
		const rd = i.rd();
		const rtValue = this.getRegV(rt);

		const self = this;

		const ops = {
			3: () => stubFn(),
			5: () => stubFn(),
			6: () => stubFn(),
			7: () => stubFn(),
			9: () => stubFn(),
			11: () => stubFn(),
			12: () => {
				console.log(`0x${self._currentPc.toString(16).padStart(8, 0)}: ${i}: mtc0  r${rt}, r${rd}, $${rtValue.toString(16).padStart(4, 0)}`);
				self._sr = rtValue;
			},
			13: () => {
				if (rtValue !== 0) {
					throw new Error("Unhandled write to CAUSE register");
				}
				console.log(`0x${self._currentPc.toString(16).padStart(8, 0)}: ${i}: mtc0  r${rt}, r${rd}, $${rtValue.toString(16).padStart(4, 0)}`);
			},
		};

		if (ops[rd] && typeof ops[rd] === "function") {
			ops[rd]();
		} else {
			console.log(`Unhandled cop0 register: ${rd}`);
		}
	},

	MFC0(i){
		const rt = i.rt();
		const rd = i.rd();
		// const rtValue = this.getRegV(rt);

		const self = this;

		const ops = {
			12: () => {
				self.setRegV(rt, self.sr);
			}
		};

		if (ops[rd] && typeof ops[rd] === "function") {
			ops[rd]();
		} else {
			console.log(`Unhandled cop0 register: ${rd}`);
		}

	},


};
