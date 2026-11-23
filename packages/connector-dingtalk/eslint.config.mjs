import baseConfig from "@repo/eslint-config";

export default [
  ...baseConfig,
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: ["@deepseek-ai/*", "@cordiverse/*", "dsh-connector-plugin"],
        },
      ],
    },
  },
];
