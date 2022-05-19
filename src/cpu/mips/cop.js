import {stubFn} from "../../utils";

export const COP = {

	MTC0(i) {
		const rt = i.rt();
		const rd = i.rd();
		const rtValue = this.getRegV(rt);

		const ops = {
			3: () => stubFn(),
			5: () => stubFn(),
			6: () => stubFn(),
			7: () => stubFn(),
			9: () => stubFn(),
			11: () => stubFn(),
			12: () => {
				this._sr = rtValue;
			},
			13: () => {
				if (rtValue !== 0) {
					throw new Error("Unhandled write to CAUSE register");
				}
				console.log(`CAUSE: mtc0, rd: ${rd}, ${rtValue}`);
			},
		};

		if (ops[rd] && typeof ops[rd] === "function") {
			ops[rd]();
		} else {
			console.log(`Unhandled cop0 register: ${rd}`);
		}
	},

	MFC0(){},


};
