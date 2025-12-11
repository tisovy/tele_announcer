const { configs } = require("@eslint/js");
const { es2024, node } = require("globals");

module.exports = [
  {
    ...configs.recommended,
    files: ["**/*.js"],
    ignores: ["node_modules/**"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...es2024,
        ...node,
        Buffer: "readonly",
        clearImmediate: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        process: "readonly",
        setImmediate: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: {
      ...configs.recommended.rules,
      "no-console": "off",
    },
  },
];

