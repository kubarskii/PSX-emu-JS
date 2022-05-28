const CopyPlugin = require("copy-webpack-plugin");
const path = require("path");

const config = {
    mode: "development",
    entry: {
        index: "./src/index.js"
    },
    devtool: "eval-source-map",
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
        libraryTarget: "umd2",
        chunkFilename: "[id].js"
    },
    devServer: {
        static: {
            directory: path.join(__dirname, "public"),
        },
        compress: true,
        port: 9001,
    },
    module: {
        rules: [
            {
                test: /\.js$/i,
                use: {
                    loader: "babel-loader",
                    options: {
                        presets: ['@babel/preset-env'],
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
