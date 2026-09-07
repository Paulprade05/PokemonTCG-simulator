"use client";

import { useHaptics } from "../../hooks/useHaptics";
import { IconoCerrar, IconoLupa } from "../icons";

/**
 * EL BUSCADOR DE UNA LISTA, UNA SOLA VEZ.
 *
 * Estaba escrito SIETE veces: la colección, el álbum de otro entrenador, buscar
 * entrenador en social, la lista de graduables, el selector de entrega del
 * mercado, la hoja de publicar del bazar y el selector de carta de la vitrina.
 * Siempre la misma idea —lupa, campo, aspa para limpiar— y siempre distinta:
 *
 *  · CUATRO de las siete no tenían aspa para limpiar. Borrar a mano un nombre
 *    de Pokémon en un teclado de móvil son diez pulsaciones sobre una tecla de
 *    borrar que está en la esquina.
 *  · Las tres que sí la tenían la hacían de tres tamaños: 44px en la colección
 *    y en el álbum de entrenador (con márgenes negativos para que el campo no
 *    diera un salto al escribir la primera letra) y 36px en social.
 *  · El envoltorio era `<label>` en cinco (tocar el icono o el relleno enfoca
 *    el campo, que es lo correcto) y `<div>` en dos (tocar al lado del texto no
 *    hacía nada).
 *  · Y los atributos del campo —`inputMode`, `enterKeyHint`, `autoCorrect`,
 *    `autoCapitalize`, `spellCheck`, esconder el aspa nativa de WebKit— iban
 *    completos en cinco y a medias en dos. Sin ellos, iOS te corrige "Gengar" y
 *    te lo pone con mayúscula.
 *
 * NO HABÍA UNA PLANTILLA BUENA: hay dos, y esto es la suma de las dos.
 * De components/vitrina/SelectorCarta.tsx salen el `<label>`, los atributos
 * completos del campo y la altura mínima de 44px — pero ésa no tenía aspa. El
 * aspa, con sus 44px y los márgenes negativos que evitan el salto de la barra
 * al escribir la primera letra, sale de app/collection/page.tsx.
 *
 * EL `Enter` DESENFOCA en lugar de enviar nada. No hay formulario que enviar
 * —la lista se filtra mientras se escribe— y en un móvil lo que hace falta al
 * terminar de escribir es que el teclado se quite de en medio para ver los
 * resultados. Es lo que ya hacían cinco de las siete copias.
 */

interface CampoBusquedaProps {
  valor: string;
  onCambio: (valor: string) => void;
  /** Nombre accesible del campo: "Buscar en tu colección", no "Buscar". */
  etiqueta: string;
  marcador?: string;
  /** Sólo para el reparto de espacio del contenedor (`flex-1`, `mt-4`…). */
  className?: string;
  /** Sólo donde el buscador es lo único que hay al abrir (la hoja de añadir
   *  amigo). En una pantalla con contenido, robar el foco sube el teclado y
   *  tapa lo que se venía a mirar. */
  autoFocus?: boolean;
}

export default function CampoBusqueda({
  valor,
  onCambio,
  etiqueta,
  marcador = "Buscar…",
  className = "",
  autoFocus = false,
}: CampoBusquedaProps) {
  const haptic = useHaptics();

  return (
    // <label> y no <div>: así tocar el icono o el relleno enfoca el campo.
    // `min-h-11` son los 44px de zona tocable; no se usa `.control-44` porque
    // esto no es un control cuadrado, sino una barra que crece a lo ancho.
    <label
      className={`input-field flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 ${className}`}
    >
      <IconoLupa tam={16} className="ink-faint" />
      <input
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        autoFocus={autoFocus}
        aria-label={etiqueta}
        placeholder={marcador}
        value={valor}
        onChange={(e) => onCambio(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        /* El aspa nativa de WebKit se esconde: ya hay una aquí al lado, con
           zona tocable de verdad, y dos aspas seguidas son un error de dibujo.
           El tamaño NO se declara: la regla `input, select, textarea` de
           globals.css fija 16px fuera de toda capa para que iOS no haga zoom, y
           cualquier clase de tamaño aquí sería letra muerta. */
        className="ink min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--ink-faint)] [&::-webkit-search-cancel-button]:hidden"
      />
      {valor && (
        <button
          type="button"
          onClick={() => {
            haptic("tap");
            onCambio("");
          }}
          aria-label="Limpiar búsqueda"
          /* Los márgenes negativos meten los 44px de zona tocable DENTRO del
             relleno del campo: sin ellos, la barra pega un salto de 18px en
             cuanto se escribe la primera letra. */
          className="ink-faint hover:ink press control-44 -my-2.5 -mr-1.5 rounded-full"
        >
          <IconoCerrar tam={16} />
        </button>
      )}
    </label>
  );
}
