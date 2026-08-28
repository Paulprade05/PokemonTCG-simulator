import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Instantáneas antiguas del proyecto (ramas feat-mobile-ux y feat-pwa-ios)
    // descomprimidas dentro de la raíz: son copias completas y sin esto el
    // lint recorre el proyecto tres veces. También están fuera de tsconfig y
    // de git; su trabajo de PWA y móvil ya está en la raíz.
    "PokemonTCG-simulator-feat-*/**",
  ]),
]);

export default eslintConfig;
