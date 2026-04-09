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
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist/main'),
  },
  externals: {
    'node-pty': 'commonjs node-pty',
  },
  node: {
    __dirname: false,
    __filename: false,
  },
};
