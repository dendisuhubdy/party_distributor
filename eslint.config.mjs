import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  // The load-bearing enforcement of the architecture. Without it the domain
  // layer erodes within weeks and every later "extract to a service" claim
  // becomes false.
  {
    files: ['lib/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['next', 'next/*', 'react', 'react-*'], message: 'Domain code must not import framework modules.' },
          { group: ['drizzle-orm', 'drizzle-orm/*', 'postgres'], message: 'Domain code must not import persistence libraries. Depend on a port interface instead.' },
          { group: ['next-auth', '@auth/*'], message: 'Domain code must not import auth libraries.' },
          { group: ['@/lib/db', '@/lib/db/*', '@/app/*'], message: 'Domain code must not import from the database or app layers.' },
        ],
      }],
    },
  },
];

export default eslintConfig;
