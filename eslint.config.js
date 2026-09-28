import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/cdk.out/**', 'spikes/**', '**/build/**', '.kiro/**', 'reference/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // CloudFront Functions（cloudfront-js-2.0）：只能用运行时支持的语法与全局对象；handler 由运行时调用
  {
    files: ['services/edge/src/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { Buffer: 'readonly' } },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^handler$', caughtErrors: 'none' }],
      'no-var': 'off',
    },
  },
  // 浏览器端用例：page.evaluate() 的回调在页面里执行
  { files: ['test/e2e/**/*.mjs'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
)
