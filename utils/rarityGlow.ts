/**
 * Color del halo de cada rareza.
 *
 * Vive aquí y no dentro del componente de la carta porque lo usan dos sitios
 * muy distintos: el `box-shadow` de la propia carta y el aura a pantalla
 * completa de la apertura de sobres, que no debe arrastrar un componente
 * cliente entero sólo para leer una tabla de colores.
 */
export const RARITY_GLOW: Record<string, string> = {
  "Hyper Rare": "rgba(250, 204, 21, 0.55)",
  "Rare Secret": "rgba(250, 204, 21, 0.5)",
  "Rare Rainbow": "rgba(244, 114, 182, 0.5)",
  "Special Illustration Rare": "rgba(217, 70, 239, 0.5)",
  "Illustration Rare": "rgba(168, 85, 247, 0.45)",
  "Shiny Ultra Rare": "rgba(56, 189, 248, 0.45)",
  "Ultra Rare": "rgba(99, 102, 241, 0.45)",
  "Rare Ultra": "rgba(99, 102, 241, 0.45)",
  "Rare Holo VSTAR": "rgba(34, 211, 238, 0.4)",
  "Rare Holo VMAX": "rgba(244, 63, 94, 0.4)",
  // Las shiny valen lo mismo que una VMAX (50 monedas) y salían con el aura
  // genérica de acento y sin punto de color en el pie de la apertura: se
  // revelaban igual que una carta sin rareza. Plata azulada, que es como se ven.
  "Shiny Rare": "rgba(148, 197, 233, 0.4)",
  "Rare Shiny": "rgba(148, 197, 233, 0.4)",
  "Double Rare": "rgba(96, 165, 250, 0.35)",
  "Rare Holo V": "rgba(96, 165, 250, 0.35)",
  "Trainer Gallery Rare Holo": "rgba(192, 132, 252, 0.35)",
  "Radiant Rare": "rgba(251, 146, 60, 0.4)",
  "Amazing Rare": "rgba(167, 243, 208, 0.4)",
  // ACE SPEC: 35 monedas, el mismo escalón que una Double Rare. Rojo, que es
  // el color con el que se imprimen.
  "ACE SPEC Rare": "rgba(248, 113, 113, 0.35)",
  "Rare Holo": "rgba(250, 204, 21, 0.25)",
  // Las promos son el suelo de esta tabla (26 monedas) pero siguen siendo algo
  // más que una común: un halo tenue las distingue sin prometer un premio.
  "Promo": "rgba(163, 163, 163, 0.28)",
};
