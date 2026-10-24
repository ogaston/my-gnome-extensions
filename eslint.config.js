// SPDX-License-Identifier: GPL-2.0-or-later
import js from '@eslint/js';

const gjsGlobals = {
    ARGV: 'readonly',
    console: 'readonly',
    global: 'readonly',
    globalThis: 'readonly',
    imports: 'readonly',
    log: 'readonly',
    logError: 'readonly',
    print: 'readonly',
    printerr: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
};

export default [
    { ignores: ['dist/', 'node_modules/'] },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: gjsGlobals,
        },
        rules: {
            'max-len': ['error', { code: 200, ignoreUrls: true }],
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
            'prefer-const': 'error',
            'no-var': 'error',
            'eqeqeq': ['error', 'always'],
        },
    },
];
