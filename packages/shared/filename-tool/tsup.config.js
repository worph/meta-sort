import {defineConfig} from 'tsup'

export default defineConfig({
  entry: {
    'index': 'src/lib/index.ts',
  },
  outDir: 'dist',
  splitting: true,
  treeshake: true,
  sourcemap: true,
  clean: false,  // Don't clean - tsc generates .d.ts files first
  dts: false,    // Let tsc handle declaration files for NodeNext compatibility
  minify: false,
  format: ['cjs', 'esm'],
})
