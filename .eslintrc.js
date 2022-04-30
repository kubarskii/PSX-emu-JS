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
        "linebreak-style": [
            "error",
            "windows"
        ],
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
