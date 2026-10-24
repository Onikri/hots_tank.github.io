import {copyFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const runtimeFiles = [
  'config.js',
  'sw.js',
  'crypto.js',
  'drive.js',
  'selftest.html',
  'icon.svg',
  'manifest.webmanifest'
];

export default defineConfig({
  base: './',
  publicDir: false,
  server: {port: 8080, strictPort: true},
  preview: {port: 8080, strictPort: true},
  esbuild: {jsx: 'automatic'},
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      onwarn(warning, warn) {
        if(warning.code==='MODULE_LEVEL_DIRECTIVE'&&warning.message.includes('use client'))return;
        warn(warning);
      },
      output: {
        assetFileNames(asset) {
          const names = asset.names || [asset.name];
          return names.includes('manifest.webmanifest')
            ? 'manifest.webmanifest'
            : 'assets/[name]-[hash][extname]';
        }
      }
    }
  },
  plugins: [{
    name: 'mediavault-runtime-files',
    apply: 'build',
    closeBundle() {
      const output = resolve(projectRoot, 'dist');
      mkdirSync(output, {recursive: true});
      for (const file of runtimeFiles) {
        copyFileSync(resolve(projectRoot, file), resolve(output, file));
      }
    }
  }]
});
