const path = require('path');

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
  node: {
    __dirname: false,
    __filename: false,
  },
};
