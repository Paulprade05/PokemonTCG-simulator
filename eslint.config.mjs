import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // TRES AJUSTES PARA QUE EL LINT SE PUEDA LEER, Y POR QUÉ CADA UNO.
  //
  // El lint llevaba meses en rojo permanente: más de 150 errores, casi todos
  // `any`, y entre ellos se perdían los pocos que sí avisan de un fallo (un
  // setState síncrono dentro de un efecto, un @ts-ignore que ya no tapa nada).
  // Un lint que siempre falla no lo mira nadie, y entonces no protege de nada.
  // Con esto, ERROR vuelve a significar «esto hay que arreglarlo» y todo lo
  // demás baja a aviso, que se ve pero no tapa. Es también la condición para
  // que el lint pueda bloquear en .github/workflows/ci.yml (ver README, «CI»).
  {
    rules: {
      // Las cartas se pintan con <img> A PROPÓSITO (presupuesto de datos: ver
      // next.config.ts y components/PokemonCard.tsx). La regla pide next/image
      // en cada una y contradice una decisión ya tomada y documentada.
      "@next/next/no-img-element": "off",
      // `any` es deuda —filas de Postgres y respuestas de APIs sin tipar—, no
      // un fallo en marcha. Sigue saliendo, como aviso, para ir bajándola.
      "@typescript-eslint/no-explicit-any": "warn",
      // Un nombre que empieza por `_` dice «sé que no lo uso»: es el convenio
      // de las firmas que tienen que aceptar un parámetro que no leen
      // (utils/mercado.ts). Sin el patrón, cada uno era un aviso falso.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
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
