"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * LAS PANTALLAS HERMANAS, CON SU NOMBRE ESCRITO.
 *
 * EL PROBLEMA. La barra de pestañas tiene cuatro sitios, y de dos de ellos
 * cuelgan otras pantallas: de Colección, la Vitrina y la Graduación; del
 * Mercado, el Bazar. En un móvil se llegaba a ellas por iconos SIN TEXTO en la
 * cabecera —una rejilla, una estrella y una casa—, con el rótulo oculto hasta
 * `lg` y un `title` que al tacto no existe. La estrella se leía como
 * "favoritos" y la casa era idéntica al icono de la pestaña Inicio, así que
 * tres pantallas enteras del juego sólo las encontraba quien tocaba por
 * probar. Los atajos con nombre existían, pero en la barra lateral de
 * escritorio (components/SidebarExtras.tsx), que en el teléfono no sale.
 *
 * LA SALIDA: una fila de dos o tres enlaces con texto bajo la cabecera, que
 * dice qué hay y marca dónde se está. No toca la barra de pestañas —meter seis
 * la dejaría intocable a 320 px— y cuesta un renglón de 58 px a cambio de que
 * un toque lleve de una hermana a otra.
 *
 * SON <Link> Y NO EL `Segmentado` DE LA CASA, aunque se le parezcan a
 * propósito (mismo recuadro, mismo tinte de acento para lo activo, que es el
 * idioma de "esto es lo seleccionado" en toda la aplicación). Segmentado
 * cambia un panel DENTRO de una pantalla: son botones con `aria-pressed` y una
 * pastilla que se desliza con `layoutId`. Esto cambia de RUTA: tiene que ser un
 * enlace (se puede abrir en otra pestaña, Next lo precarga, el lector lo
 * anuncia como navegación y `aria-current="page"` dice cuál es la actual), y
 * la pastilla no puede deslizarse entre dos pantallas que se montan y
 * desmontan.
 *
 * SIN ICONOS, y también a propósito: el fallo era que había iconos sin
 * palabras. A 320 px tres enlaces se reparten 264 px —88 cada uno— y
 * "Graduación" con un icono al lado no cabe; entre la palabra y el dibujo, la
 * que no se puede quitar es la palabra.
 *
 * NITIDEZ: `press-flat` hunde 2 px sin escalar, y esta fila nunca es ancestro
 * de una carta.
 */

interface Acceso {
  href: string;
  rotulo: string;
  /** Rutas en las que este acceso es "donde estás". */
  activa: (ruta: string) => boolean;
}

const GRUPOS: Record<"coleccion" | "mercado", { etiqueta: string; accesos: Acceso[] }> = {
  coleccion: {
    etiqueta: "Secciones de la colección",
    accesos: [
      {
        href: "/collection",
        rotulo: "Cartas",
        // El álbum de una expansión es la colección mirada de cerca.
        activa: (r) => r.startsWith("/collection") || r.startsWith("/album"),
      },
      { href: "/vitrina", rotulo: "Vitrina", activa: (r) => r.startsWith("/vitrina") },
      { href: "/graduacion", rotulo: "Graduación", activa: (r) => r.startsWith("/graduacion") },
    ],
  },
  mercado: {
    etiqueta: "Secciones del mercado",
    accesos: [
      { href: "/mercado", rotulo: "Encargos", activa: (r) => r.startsWith("/mercado") },
      { href: "/bazar", rotulo: "Bazar", activa: (r) => r.startsWith("/bazar") },
    ],
  },
};

export default function FilaAccesos({
  grupo,
  className = "",
}: {
  /** Qué familia de pantallas enlaza. */
  grupo: "coleccion" | "mercado";
  /** Espacio alrededor (`mb-5`…). Nada de estilo interno. */
  className?: string;
}) {
  const ruta = usePathname() ?? "";
  const { etiqueta, accesos } = GRUPOS[grupo];

  return (
    <nav
      aria-label={etiqueta}
      // Tope de ancho a partir de `sm`: en escritorio la fila no tiene por qué
      // cruzar los 1280 px del <main> para decir tres palabras.
      className={`surface-2 flex gap-1.5 rounded-2xl p-1.5 sm:max-w-md ${className}`}
    >
      {accesos.map((a) => {
        const actual = a.activa(ruta);
        return (
          <Link
            key={a.href}
            href={a.href}
            aria-current={actual ? "page" : undefined}
            // El borde existe SIEMPRE (transparente en reposo) para que marcar
            // el activo no mueva el texto un píxel.
            className={`press-flat control-44 flex-1 rounded-xl border px-2 t-cuerpo-2 font-semibold ${
              actual
                ? "ink border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]"
                : "ink-soft border-transparent"
            }`}
          >
            <span className="truncate">{a.rotulo}</span>
          </Link>
        );
      })}
    </nav>
  );
}
