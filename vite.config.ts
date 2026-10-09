/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

// GitHub Pages serves the site from /<repo>/; override with BASE_PATH if needed.
export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  plugins: [solid()],
  test: {
    environment: 'node',
  },
})
