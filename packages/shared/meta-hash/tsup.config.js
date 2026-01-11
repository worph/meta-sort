import {defineConfig} from 'tsup'

export default defineConfig({
  entry: {
    'index': 'src/lib/index.ts',
    'index-interface': 'src/lib/index-interface.ts',
    'index-browser': 'src/lib/index-browser.ts',
    'worker': 'src/lib/file-id/ShaComputeWorker.ts',
  },
  splitting: true,
  treeshake: true,
  sourcemap: true,
  clean: true,
  dts:true,
  minify:false,
  format: ['cjs', 'esm'],
})
