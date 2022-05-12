export const COP = {

	MTC0(i) {
		const rt = i.rt();
		const rd = i.rd();
		const rtValue = this.getRegV(rt);

		switch (rd) {
		case 12:
			this._sr = rtValue;
			break;
		default:
			console.log(`Unhandled cop0 register: ${rd}`);
		}

	},

};
