"use client";

/**
 * EL LOMO Y LAS ANILLAS.
 *
 * Parece adorno y no lo es: es la pieza que resuelve un conflicto real de
 * gestos. `components/ui/EdgeBackGesture.tsx` escucha `pointerdown` en
 * `document` y, con la app instalada como PWA, un arrastre de 84px que EMPIECE
 * a menos de 26px del borde izquierdo llama a `router.back()`. Si el pase de
 * página del archivador empezara pegado a ese borde, el gesto se lo comería:
 * el jugador querría ir a la hoja anterior y saldría de la vitrina.
 *
 * La salida no es pelearse con ese oyente (no se puede desactivar desde fuera;
 * sólo se rinde si hay un `[role="dialog"]` en el DOM, y colgar un diálogo
 * falso para engañarlo destrozaría el árbol de accesibilidad de la página).
 * La salida es GEOMÉTRICA: el lomo ocupa el canto izquierdo y NO escucha el
 * gesto —la ventana que sí lo escucha empieza a su derecha—. Sumando el
 * relleno del <main> de AppShell (16px), el de la tapa (10px) y el ancho del
 * lomo (24px en móvil), el arrastre de página no puede arrancar antes de los
 * ~50px: el doble de la franja de EdgeBackGesture. Y el resultado es además el
 * correcto de mirar, porque un archivador de verdad tiene lomo.
 *
 * Todo el bloque es `aria-hidden`: para un lector de pantalla no hay nada aquí.
 * Y todo se dibuja con gradientes y `box-shadow`; ni un `filter`, que sobre un
 * hermano no importaría, pero es la regla de la pantalla entera y no conviene
 * dejar excepciones sueltas donde alguien pueda copiarlas.
 */

/* Alturas relativas de las tres anillas. Se reparten con margen respecto a los
 * cantos (18/50/82 y no 10/50/90) para que ninguna quede cortada cuando la
 * hoja es baja —el archivador filtrado a una expansión de pocas cartas sigue
 * midiendo tres filas, pero en móvil apaisado esas filas son cortas—. */
const POSICIONES = [18, 50, 82];

/* Metal. Nada de gris a pelo: se mezcla --ink con --surface, así que en tema
 * claro sale un peltre oscuro sobre papel y en tema oscuro un metal claro
 * sobre carbón, sin escribir dos paletas. */
const METAL =
  "linear-gradient(180deg," +
  " color-mix(in srgb, var(--ink) 10%, var(--surface)) 0%," +
  " color-mix(in srgb, var(--ink) 45%, var(--surface)) 42%," +
  " color-mix(in srgb, var(--ink) 30%, var(--surface)) 62%," +
  " color-mix(in srgb, var(--ink) 55%, var(--surface)) 100%)";

/* El canal del lomo: oscurece hacia la derecha, que es donde la hoja se dobla
 * y entra en las anillas. */
const LOMO: React.CSSProperties = {
  background:
    "var(--grain), linear-gradient(90deg," +
    " color-mix(in srgb, var(--ink) 6%, var(--surface)) 0%," +
    " color-mix(in srgb, var(--ink) 12%, var(--surface)) 55%," +
    " color-mix(in srgb, var(--ink) 22%, var(--surface)) 100%)",
  boxShadow:
    "inset -7px 0 12px -9px rgba(0,0,0,0.55), inset 1px 0 0 color-mix(in srgb, #fff 10%, transparent)",
};

export default function AnillasArchivador() {
  return (
    <div
      aria-hidden="true"
      /* z-20 para pintarse por encima de la hoja: las anillas tienen que pasar
         por delante del canto del papel, no por detrás, o no se leen como
         anillas. La hoja pasa por debajo de ellas cuando se pasa de página,
         que es exactamente lo que hace un archivador de verdad. */
      className="relative z-20 w-6 shrink-0 rounded-l-2xl sm:w-9"
      style={LOMO}
    >
      {POSICIONES.map((top) => (
        <span
          key={top}
          /* `pointer-events-none` es obligatorio, no cosmético: las anillas
             invaden 9px de la ventana que escucha el arrastre, y sin esto un
             pase de página que empezara justo ahí se perdería. */
          className="pointer-events-none absolute rounded-full"
          style={{
            top: `${top}%`,
            left: "30%",
            right: "-9px",
            height: "clamp(16px, 3.6vw, 28px)",
            transform: "translateY(-50%)",
            background: METAL,
            /* Reflejo arriba, contacto abajo y una sombra corta proyectada
               sobre la hoja: tres capas de box-shadow bastan para que el
               cilindro parezca redondo. */
            boxShadow:
              "inset 0 1.5px 0 color-mix(in srgb, #fff 45%, transparent)," +
              " inset 0 -1.5px 0 rgba(0,0,0,0.35)," +
              " 2px 2px 4px -1px rgba(0,0,0,0.35)",
          }}
        />
      ))}
    </div>
  );
}
