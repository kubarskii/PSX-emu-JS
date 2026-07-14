const CopyPlugin = require("copy-webpack-plugin");
const path = require("path");

const isProd = process.env.NODE_ENV === "production";
const publicPath = process.env.PUBLIC_PATH || "/";

const config = {
    mode: isProd ? "production" : "development",
    entry: {
        index: "./src/index.js"
    },
    devtool: isProd ? false : "eval-source-map",
    resolve: {
        extensions: [".js"]
    },
    performance: {
        hints: false,
        maxEntrypointSize: 512000,
        maxAssetSize: 512000
    },
    output: {
        filename: "index.js",
        path: path.resolve(__dirname, "dist"),
        publicPath,
        libraryTarget: "umd2",
        chunkFilename: "[id].js"
    },
    devServer: {
        static: {
            directory: path.join(__dirname, "public"),
        },
        compress: true,
        port: process.env.PORT || 9001,
    },
    module: {
        rules: [
            {
                test: /\.js$/i,
                use: {
                    loader: "babel-loader",
                    options: {
                        // modern targets: keep classes/private fields/typed
                        // arrays native, ES5 transpilation kills the
                        // emulator hot path
                        presets: [['@babel/preset-env', {
                            targets: {chrome: "100", firefox: "100", safari: "15.4"},
                            bugfixes: true,
                        }]],
                    }
                }
            }
        ]
    },
    plugins: [
        new CopyPlugin({
            patterns: [
                {from: path.resolve(__dirname, "public"), to: ""},
            ]
        })
    ]
};

module.exports = config;
