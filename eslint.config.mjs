import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".next/**", "dist/**", "assets/**", "node_modules/**"] },
  tseslint.configs.recommended,
);
