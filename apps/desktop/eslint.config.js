import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'src-tauri/target']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    // Vendored and registry-managed components keep their upstream module shape.
    files: [
      'src/components/ui/**',
      'src/components/motion/**',
      'src/components/agents/**',
      'src/components/beui/**',
      'src/components/synara/**',
      'src/lib/synara/**',
    ],
    rules: {
      'react-refresh/only-export-components': 'off',
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    // These app modules intentionally colocate React components and shared helpers.
    files: ['src/components/kybern/Markdown.tsx', 'src/views/chrome.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // Existing imperative surfaces are not compiled with React Compiler.
    files: ['src/views/Explorer.tsx', 'src/views/PullRequests.tsx', 'src/views/Terminal.tsx'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: ['src/views/Environment.tsx'],
    rules: {
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  {
    files: ['src/views/Terminal.tsx'],
    rules: {
      'react-hooks/refs': 'off',
    },
  },
])
