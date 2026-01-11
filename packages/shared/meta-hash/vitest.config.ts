import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            '@root': path.resolve(__dirname, './src/lib')
        }
    },
    test: {
        globals: true,
        environment: 'node',
        testTimeout: 300000, // Set global timeout to 30 seconds
        // Use ts-jest or esbuild to handle TypeScript files
        // Specify other configurations as needed
    },
});
