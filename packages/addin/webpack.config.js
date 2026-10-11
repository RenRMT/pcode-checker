/* eslint-disable no-undef */
const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const CustomFunctionsMetadataPlugin = require("custom-functions-metadata-plugin");

const urlDev = "https://localhost:3000/";
const urlProd = process.env.ADDIN_URL || "https://renrmt.github.io/pcode-checker/";
// Country files live next to the add-in (same origin, no CORS). The dev server
// serves ../../site/data, which `uv run python build.py` in data-build creates.
const dataBase = process.env.DATA_BASE || "data/";

module.exports = async (env, options) => {
  const dev = options.mode === "development";
  const config = {
    devtool: dev ? "source-map" : false,
    entry: {
      taskpane: "./src/taskpane/taskpane.ts",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "[name].js",
      clean: true,
    },
    resolve: {
      extensions: [".ts", ".js"],
      alias: {
        "@pcode-checker/core": path.resolve(__dirname, "../core/src/index.ts"),
      },
      // core uses NodeNext-style ".js" imports for its own ".ts" files
      extensionAlias: { ".js": [".ts", ".js"] },
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: { loader: "ts-loader", options: { onlyCompileBundledFiles: true } },
        },
      ],
    },
    plugins: [
      new webpack.DefinePlugin({ __DATA_BASE__: JSON.stringify(dataBase) }),
      new CustomFunctionsMetadataPlugin({
        output: "functions.json",
        input: "./src/functions/functions.ts",
      }),
      new HtmlWebpackPlugin({
        filename: "taskpane.html",
        template: "./src/taskpane/taskpane.html",
        chunks: ["taskpane"],
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: "assets/*", to: "assets/[name][ext]" },
          { from: "src/taskpane/taskpane.css", to: "taskpane.css" },
          {
            from: "manifest.xml",
            to: "manifest.xml",
            transform: (content) => (dev ? content : content.toString().replace(new RegExp(urlDev, "g"), urlProd)),
          },
        ],
      }),
    ],
    performance: { hints: false },
  };

  if (process.env.WEBPACK_SERVE) {
    const devCerts = require("office-addin-dev-certs");
    const https = await devCerts.getHttpsServerOptions();
    config.devServer = {
      port: Number(process.env.npm_package_config_dev_server_port || 3000),
      headers: { "Access-Control-Allow-Origin": "*" },
      server: { type: "https", options: { ca: https.ca, key: https.key, cert: https.cert } },
      static: [{ directory: path.resolve(__dirname, "../../site/data"), publicPath: "/data" }],
    };
  }
  return config;
};
