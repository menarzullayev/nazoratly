import react from "eslint-plugin-react";
import hooks from "eslint-plugin-react-hooks";
import ts from "typescript-eslint";

// Text that is the same in every language and may be written in the markup.
const NEUTRAL_TEXT = ["·", "—", "–", "/", ":", "(", ")", "%", "+", "×", "#", "…", ",", "→", "←", "-", "nazoratly"];

/** Two panel rules that must break CI: no raw HTML injection, and no text written into the markup (it must come from
 * the dictionaries, or four of the five languages would show it untranslated). Exported for the negative tests. */
export const panelRules = {
  "react/no-danger": "error",
  "react/jsx-no-literals": ["error", { noStrings: true, ignoreProps: true, allowedStrings: NEUTRAL_TEXT }],
  "no-restricted-syntax": [
    "error",
    { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: "Raw HTML is forbidden: render user text as text." },
    { selector: "MemberExpression[property.name=/^(innerHTML|outerHTML|insertAdjacentHTML)$/]", message: "Raw HTML is forbidden." },
    { selector: "CallExpression[callee.name='eval']", message: "eval is forbidden." },
    {
      selector: "JSXAttribute[name.name=/^(aria-label|title|placeholder|alt|label)$/] > Literal[value=/[A-Za-zА-Яа-я]/]",
      message: "Visible text must come from the dictionaries (t(...)).",
    },
    {
      selector: "MemberExpression[object.name=/^(localStorage|sessionStorage)$/]",
      message: "Use src/lib/prefs.ts: it keeps only non-secret preferences. Tokens are never stored.",
    },
    { selector: "Identifier[name='indexedDB']", message: "The panel stores nothing in IndexedDB." },
  ],
};

const config = [
  { ignores: ["dist/**", "test-results/**", "playwright-report/**", "test/fixtures/**"] },
  ...ts.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { react, "react-hooks": hooks },
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    settings: { react: { version: "19.3" } },
    rules: { ...panelRules, "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
  },
  { files: ["src/lib/prefs.ts"], rules: { "no-restricted-syntax": "off" } },
  { files: ["e2e/**/*.ts"], rules: { "@typescript-eslint/no-explicit-any": "off" } },
];

export default config;
