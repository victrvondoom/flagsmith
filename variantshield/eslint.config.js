import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "data/**", "bench-output/**", "docs/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off", // tests parse untyped JSON responses
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  { files: ["apps/dashboard/public/**/*.js", "apps/checkout-demo/public/**/*.js"], languageOptions: { globals: globals.browser } },
  { files: ["**/*.test.ts", "tests/**/*.ts"], rules: { "@typescript-eslint/no-non-null-assertion": "off" } },
);
