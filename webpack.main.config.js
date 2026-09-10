const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  mode: 'production',
  devtool: 'source-map',
  entry: {
    main: './src/main/main.ts',
    preload: './src/main/preload.ts',
  },
  target: 'electron-main',
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
    // ws optional native accelerators: use its pure-JS fallbacks instead
    fallback: { bufferutil: false, 'utf-8-validate': false },
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist/main'),
  },
  externals: {
    'node-pty': 'commonjs node-pty',
    // CRITICAL: bundled ws deadlocks the event loop (pipe-poll hang after
    // first outbound broadcast; reproduced standalone in plain node — see
    // docs/test-reports/M2-report.md). Keep it external like node-pty.
    ws: 'commonjs ws',
  },
  plugins: [
    // WBS-R2-G: relay 插件以原样 .mjs 随 dist 分发（ws 为运行时 external，
    // 无需打包），utilityProcess 直接加载 dist/plugins/relayPlugin.mjs。
    new CopyWebpackPlugin({
      patterns: [{ from: 'relay/src/plugin/relayPlugin.mjs', to: '../plugins/relayPlugin.mjs' }],
    }),
  ],
  node: {
    __dirname: false,
    __filename: false,
  },
};
