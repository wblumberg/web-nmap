const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';

  return {
    entry: './src/main.js',

    devtool: isProd ? 'source-map' : 'eval-source-map',

    module: {
      rules: [
        // WASM — emit as asset so autumnplot-gl can load it at runtime
        {
          test: /\.wasm$/,
          type: 'asset/resource',
          generator: {
            filename: '[name].wasm',
          },
        },
      ],
    },

    resolve: {
      extensions: ['.js', '.ts'],
      // Node.js polyfills are not needed; suppress webpack 5 warnings
      fallback: {},
    },

    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'bundle.[contenthash].js',
      clean: true,
      publicPath: '/',
    },

    plugins: [
      new HtmlWebpackPlugin({
        template: './index.html',
        // index.html already has the maplibre/pako/float16 CDN scripts and
        // the manual <script type="module" src="/src/main.js">.
        // HtmlWebpackPlugin will inject the webpack bundle and we remove
        // the manual module script via templateParameters.
        inject: 'body',
        scriptLoading: 'module',
      }),
    ],

    devServer: {
      host: '127.0.0.1',
      port: 5173,
      allowedHosts: 'all',
      static: [
        // Serve /public as the webroot (CSS, WASM, tiles, fonts, etc.)
        { directory: path.join(__dirname, 'public'), publicPath: '/' },
      ],
      // Disable gzip compression in dev — it buffers SSE streams and prevents
      // the EventSource from receiving events in real time.
      compress: false,
      hot: true,
      proxy: [
        // SSE endpoint — must be listed before the general /api rule.
        // http-proxy-middleware v2 uses `on: { proxyReq, proxyRes }` (not top-level
        // onProxyReq/onProxyRes which were v1-only and are silently ignored in v2).
        // proxyTimeout: 0 disables the idle-disconnect that kills long-lived connections.
        {
          context: ['/api/v1/events'],
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
          proxyTimeout: 0,
          timeout: 0,
          on: {
            proxyReq(proxyReq) {
              // Tell FastAPI not to bother compressing — plain text is fine for SSE.
              proxyReq.setHeader('Accept-Encoding', 'identity');
            },
          },
        },
        {
          context: ['/api'],
          target: 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
      ],
    },
  };
};
