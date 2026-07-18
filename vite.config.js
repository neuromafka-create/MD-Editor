import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist'
  },
  server: {
    watch: {
      ignored: ['**/src-tauri/target/**']
    }
  }
});
