import type { Service, ServiceCategory } from "@/lib/api-types";

/**
 * Service imagery.
 *
 * The catalogue is data, not code — services are rows the salon edits through
 * the console — so a service's picture is *resolved* from its name first and
 * its category second, rather than being stored per row. That keeps the cards
 * illustrated without a schema change, and a service the salon adds later gets
 * a sensible picture the moment it is created.
 *
 * The files live in `public/assets`, so they are served from `/assets/…` and
 * need no bundler import.
 */

const BASE = "/assets";

/**
 * Name keyword → file, checked in order against the lower-cased service name.
 *
 * Order matters: the first match wins, so the specific wellness names are
 * listed above the broad hair/skin words they would otherwise collide with.
 * ("Korean Glass Skin Drip" contains both "skin" and "drip"; it belongs with
 * the drips.)
 *
 * These are placeholders. The salon's own treatment photography replaces them
 * by dropping a file in `public/assets` and adding a line here — no schema
 * change, which is the point of resolving rather than storing the picture.
 */
const BY_KEYWORD: { match: RegExp; file: string }[] = [
  // --- wellness: drips, shots and add-ons --------------------------------
  { match: /(drip|infusion|intravenous|\biv\b)/, file: "white.jpg" },
  { match: /(shot|injectable|placenta|rejuvenat|anti-?aging)/, file: "oilface.jpg" },
  { match: /(add-?on|booster|multivitamin|vitamin|glutathione|collagen|zinc)/, file: "white.jpg" },
  // --- salon and spa ------------------------------------------------------
  { match: /(hot stone|stone|bato)/, file: "bato.jpg" },
  { match: /(massage|deep tissue|shiatsu|relax)/, file: "massage.jpg" },
  { match: /(facial|face|skin|glow|bright|peel)/, file: "oilface.jpg" },
  { match: /(mask|cleanse|oilface)/, file: "white.jpg" },
  { match: /(nail|manicure|pedicure|hand|feet|foot)/, file: "nail.jpg" },
  { match: /(perm|curl|wave|styl|blow ?dry|cut|trim|updo|hairdo)/, file: "perm.jpg" },
  { match: /(color|colour|dye|highlight|balayage|tint|bleach|foil)/, file: "color.jpg" },
  { match: /(treat|hair)/, file: "haircolor.jpg" },
];

/** Category → file, used when the name gives nothing away. */
const BY_CATEGORY: Record<ServiceCategory, string> = {
  SPA: "massage.jpg",
  SALON: "haircolor.jpg",
  WELLNESS: "white.jpg",
};

/** The `/assets/…` URL for a service's picture. */
export function serviceImage(service: Pick<Service, "name" | "category">): string {
  const name = service.name.toLowerCase();
  const hit = BY_KEYWORD.find((k) => k.match.test(name));
  return `${BASE}/${hit ? hit.file : BY_CATEGORY[service.category]}`;
}
