import type { Metadata } from "next";
import Vitrina from "../../components/Vitrina";

/**
 * Ruta de la vitrina.
 *
 * Es una cáscara de SERVIDOR a propósito, y por eso aquí no hay ni un "use
 * client": todo el trabajo vive en components/Vitrina.tsx, que sí es de
 * cliente porque necesita estado, gestos y las server actions de la colección.
 *
 * El motivo de partirlo en dos es `metadata`. Un componente de cliente no
 * puede exportarla, así que el resto de rutas de este repositorio (colección,
 * álbum) resuelven lo mismo con un `layout.tsx` mínimo que devuelve sus
 * children sólo para poder poner el título de la pestaña. Aquí no hace falta
 * ese layout: dejando la página como componente de servidor, el título va
 * donde le corresponde y el árbol renderizado no gana un nivel de más.
 */

export const metadata: Metadata = {
  title: "Vitrina · TCG Sim",
  description:
    "Tu colección en un archivador de nueve cartas por hoja, como el de la mesa",
};

export default function VitrinaPage() {
  return <Vitrina />;
}
