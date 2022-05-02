export const SHIFTER = {

	SLL(i){
		const rd = i.rd();
		const rt = i.rt();
		const sa = i.shamt();

		this.setReg(rd, this.getReg(rt) << sa);
	}

};
