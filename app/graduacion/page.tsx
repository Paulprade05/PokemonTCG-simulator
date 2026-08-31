import type { Metadata } from "next";
import Graduacion from "../../components/graduacion/Graduacion";

/**
 * Ruta del graduador.
 *
 * Cáscara de SERVIDOR, igual que app/vitrina/page.tsx y por el mismo motivo:
 * aquí no hay "use client" para que la página pueda exportar `metadata`. Todo
 * el trabajo vive en components/graduacion/, que sí es de cliente porque
 * necesita estado, cerrojos y las server actions.
 *
 * La alternativa que usan la colección y el álbum —un `layout.tsx` mínimo que
 * sólo devuelve sus children para poder poner el título— aquí no hace falta y
 * además añadiría un nivel al árbol renderizado sin dar nada a cambio.
 *
 * LA BARRA INFERIOR YA CUBRE ESTA RUTA: components/nav-items.tsx mete
 * /graduacion dentro de la pestaña de Colección, porque graduar es un servicio
 * que se presta sobre las cartas que ya tienes. Si no estuviera, la pestaña se
 * apagaría al entrar aquí y la barra parecería rota.
 */

export const metadata: Metadata = {
  title: "Graduación · TCG Sim",
  description:
    "Manda tus copias repetidas a graduar y descubre la nota que cada una ya tenía",
};

export default function GraduacionPage() {
  return <Graduacion />;
}
