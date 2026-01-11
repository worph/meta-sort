import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        testTimeout: 300000, // Set global timeout to 30 seconds
        // Use ts-jest or esbuild to handle TypeScript files
        // Specify other configurations as needed
    },
});
