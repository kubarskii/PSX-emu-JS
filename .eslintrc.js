module.exports = {
    "env": {
        "browser": true,
        "commonjs": false,
        "es2021": true,
        "jest": true,
    },
    "extends": "eslint:recommended",
    "parserOptions": {
        "ecmaVersion": "latest",
        "sourceType": "module",
        "ecmaFeatures": {
            "jsx": true
        }
    },
    "plugins": ["jest"],
    "ignorePatterns": [
        "dist",
        "webpack.*.js",
        "jest.*.js",
        ".eslintrc.js",
        "babel.*.js"
    ],
    "rules": {
        "indent": [
            "error",
            "tab"
        ],
        // the repo stores LF; Windows checkouts convert to CRLF, so
        // enforcing either style fails lint on the other platform (CI)
        "linebreak-style": "off",
        "quotes": [
            "error",
            "double"
        ],
        "semi": [
            "error",
            "always"
        ]
    }
};
