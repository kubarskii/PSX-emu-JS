const mips_ops = {
	/**
     * Load Upper Immediate
     * */
	lui(t, imm) {
		const value = imm << 16;
		this.setReg(t, value);
	},

	ori(t, imm){

	},
};


