const path = require('path');

module.exports = {
    entry: './src/index.js',
    devtool: 'source-map',
    module: {
        rules: [
            {
                test: /\.[tj]s$/,
                use: 'ts-loader',
                exclude: /node_modules/,
            },
            // GLSL Shaders
            {
                test: /\.glsl$/,
                loader: 'webpack-glsl-loader',
                exclude: /node_modules/,
            },
            // WASM
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
        extensions: ['.ts', '.js'],
    },

    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'web-nmap.js',
        clean: true,
        globalObject: 'this',
        library: {
            name: 'apgl',
            type: 'umd',
        },
    },

    devServer: {
        static: {
            directory: path.join(__dirname, 'public'),
        },
        compress: true,
        port: 9000,
        proxy: [
            {
                context: ['/api'],
                target: 'http://localhost:8000',
                changeOrigin: true, // Helps prevent host-header mismatches
                secure: false,      // Useful if you switch to local HTTPS later
                timeout: 600000,      // 10 minutes: Timeout for incoming requests to dev-server
                proxyTimeout: 600000, // 10 minutes: Timeout for dev-server requests to FastAPI
            }
        ]
    },
};

// Add this inside devServer: {}
devServer: {
}
