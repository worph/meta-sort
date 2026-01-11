import {defineConfig} from 'tsup'

export default defineConfig({
  entry: {
    'index': 'src/lib/index.ts',
  },
  outDir: 'dist',
  splitting: true,
  treeshake: true,
  sourcemap: true,
  clean: true,
  dts:true,
  minify:false,
  format: ['cjs', 'esm'],
})
