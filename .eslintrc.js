'use strict';

module.exports = {
  extends: ['athom'],
  parserOptions: {
    ecmaVersion: 2022,
  },
  env: {
    node: true,
    es6: true,
  },
  overrides: [
    {
      files: ['tests/**/*.js'],
      env: {
        jest: true,
        node: true,
      },
      rules: {
        strict: 'off',
        'no-console': 'off',
        'import/no-dynamic-require': 'off',
        'no-restricted-properties': 'off',
        'no-unused-vars': 'warn',
        'no-use-before-define': 'off',
        'node/no-unsupported-features/es-syntax': 'off',
      },
    },
  ],
};
