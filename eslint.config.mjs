import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".next/**", "dist/**", "node_modules/**"] },
  tseslint.configs.recommended,
);
