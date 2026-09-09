// Web client bundle (M2-E): second webpack entry targeting the browser.
// Output lands in dist/web — exactly where RemoteServer's webRoot points
// (dist/main/main.js resolves ../web). Served over HTTPS/WSS in M3.
const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
  mode: 'production',
  entry: './src/web/index.ts',
  target: 'web',
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: [MiniCssExtractPlugin.loader, 'css-loader'],
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    filename: 'web.js',
    path: path.resolve(__dirname, 'dist/web'),
    clean: true,
    // RemoteServer serves assets only under /static/* — emit absolute
    // URLs so the browser resolves /static/web.js instead of /web.js
    // (which would 404 and blank the page in a real browser).
    publicPath: '/static/',
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/web/index.html',
      filename: 'index.html',
    }),
    new MiniCssExtractPlugin({
      filename: 'style.css',
    }),
    new CopyWebpackPlugin({
      patterns: [
        { from: 'node_modules/@xterm/xterm/css/xterm.css', to: 'xterm.css' },
      ],
    }),
  ],
};
