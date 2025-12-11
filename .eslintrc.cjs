module.exports = {
  env: {
    node: true,
    es2021: true,
  },
  extends: ["eslint:recommended"],
  parserOptions: {
    ecmaVersion: 2021,
  },
  ignorePatterns: ["node_modules/"],
  rules: {
    "no-console": "off",
  },
};

