import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Only this app's own sources are linted. Without these ignores `eslint .`
  // walks the Python venv, the model directory and built helper bundles, which
  // made a full lint take minutes instead of seconds.
  {
    ignores: [
      "dist",
      ".output",
      ".vinxi",
      ".xtts-venv",
      "models",
      "coverage",
      ".jarvis",
      "native",
      "local-agent/node_modules",
      "vscode-extension/out",
      "vscode-extension/node_modules",
      "vscode-extension/.vscode-test",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Vendored shadcn/ui primitives intentionally export their variants and
    // helpers next to the component (that is how they are generated and
    // updated). Fast Refresh still works for the app's own components.
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: { "react-refresh/only-export-components": "off" },
  },
  eslintPluginPrettier,
);
