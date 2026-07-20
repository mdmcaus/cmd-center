// ESLint flat config with security-focused plugins.
// - eslint-plugin-security: flags risky Node patterns (child_process, non-literal
//   fs paths, unsafe regex, etc.)
// - eslint-plugin-no-unsanitized: flags unsafe DOM sinks (innerHTML with data)
// Run: npm run lint  (or: make lint)

const security = require('eslint-plugin-security');
const noUnsanitized = require('eslint-plugin-no-unsanitized');

module.exports = [
  {
    ignores: ['node_modules/**', 'public/vendor/**', 'test-results/**', 'playwright-report/**'],
  },
  // Node code: server, library, tests, scripts, config.
  {
    files: ['server.js', 'lib/**/*.js', 'test/**/*.js', 'scripts/**/*.js', '*.config.js'],
    plugins: { security },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        process: 'readonly',
        __dirname: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      ...security.configs.recommended.rules,
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  // Browser code: the frontend served from public/.
  {
    files: ['public/**/*.js'],
    ignores: ['public/vendor/**'],
    plugins: { 'no-unsanitized': noUnsanitized },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Terminal: 'readonly',
        FitAddon: 'readonly',
      },
    },
    rules: {
      'no-unsanitized/property': 'error',
      'no-unsanitized/method': 'error',
    },
  },
];
