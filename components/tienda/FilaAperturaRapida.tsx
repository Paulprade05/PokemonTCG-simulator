"use client";

/**
 * EL INTERRUPTOR DE "APERTURA RÁPIDA", EN LA PROPIA TIENDA.
 *
 * Abrir veinte sobres Estándar seguidos eran ochenta toques y veintitrés
 * segundos de animación obligatoria; el ×10 sí iba directo al resumen, pero
 * exigía comprar diez de golpe. Con esto activo, un sobre suelto hace lo mismo
 * que el ×10: se compra y se enseña el resumen.
 *
 * VA AQUÍ Y NO SÓLO EN AJUSTES porque es donde se echa de menos: quien está
 * abriendo en serie no va a salir a buscar una hoja de ajustes entre sobre y
 * sobre. La preferencia se guarda con clave propia (components/tienda/memoria.ts
 * explica por qué no dentro de `tcg-ajustes`), así que Ajustes puede pintar
 * este mismo interruptor sin tocar nada de aquí.
 *
 * EL DIBUJO ES EL DE components/ui/SettingsSheet.tsx (píldora de 50x30 y pomo
 * blanco de 24): un interruptor tiene que ser el mismo objeto en toda la
 * aplicación. Está copiado porque allí es una función interna de la hoja; si
 * algún día se extrae a components/ui, éste debe pasar a usarla.
 */
interface FilaAperturaRapidaProps {
  activa: boolean;
  onCambiar: (activa: boolean) => void;
}

export default function FilaAperturaRapida({ activa, onCambiar }: FilaAperturaRapidaProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={activa}
      onClick={() => onCambiar(!activa)}
      className="surface touch-target flex w-full items-center justify-between gap-4 rounded-2xl px-4 py-3 text-left"
    >
      <span className="min-w-0">
        <span className="ink t-cuerpo block font-medium">Apertura rápida</span>
        {/* ink-soft y no ink-faint: es la frase que explica qué hace el
            interruptor, y a 12px --ink-faint (3,66:1) no llega al mínimo. */}
        <span className="ink-soft t-cuerpo-2 mt-0.5 block leading-snug">
          Cada sobre va directo al resumen, sin la animación de rasgarlo.
        </span>
      </span>
      {/* La píldora es decorativa: el estado real lo anuncia aria-checked. */}
      <span
        aria-hidden="true"
        className="relative shrink-0 rounded-full"
        style={{
          width: 50,
          height: 30,
          background: activa ? "var(--accent)" : "color-mix(in srgb, var(--ink) 16%, transparent)",
          transition: "background-color var(--d-base) var(--ease-out)",
        }}
      >
        <span
          className="absolute top-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: 24,
            height: 24,
            left: activa ? 23 : 3,
            // Blanco y sombra fijos, como el pomo de Ajustes: tiene que
            // contrastar sobre el acento y sobre el gris en los dos temas.
            background: "#fff",
            boxShadow: "0 1px 3px rgba(0,0,0,.35)",
            transition: "left var(--d-base) var(--ease-out)",
          }}
        />
      </span>
    </button>
  );
}
