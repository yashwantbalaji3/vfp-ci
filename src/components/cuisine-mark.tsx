/**
 * A small original drawing for a kind of food (owner decision D3, 22 Nov 2026): a fallback picture for a place
 * or a meal until rights-documented photographs exist. Drawn by this code from simple shapes; it shows a kind of
 * food, never a particular restaurant's dish, and it is decorative (the name next to it carries the meaning).
 * It says nothing about whether anything is vegetarian or vegan.
 */
export type CuisineFamily = "pizza" | "noodles" | "sushi" | "taco" | "curry" | "pita" | "burger" | "sandwich" | "salad" | "cup" | "plate";

const FAMILY: [RegExp, CuisineFamily][] = [
  [/coffee|café|cafe|juice|tea\b|smoothie/i, "cup"],
  [/pizza|italian/i, "pizza"],
  [/sushi|poke/i, "sushi"],
  [/chinese|thai|vietnam|asian|korean|ramen|taiwan|cambod|japan|noodle|pho|lao|malays|indones|filipin/i, "noodles"],
  [/mexic|taco|latin|colomb|domin|salvador|cuba|peru|brazil|venez|puerto|caribb|jamaic|burrito|guatemal/i, "taco"],
  [/indian|nepal|afghan|ethiop|african|pakistan|bangla|sri lank|halal|curry|tibet/i, "curry"],
  [/mediterr|greek|middle east|leban|turk|israel|falafel|persian|moroc|egypt/i, "pita"],
  [/sandwich|deli|bagel|breakfast|brunch|bakery|bread/i, "sandwich"],
  [/salad|vegan|vegetarian|health|bowl/i, "salad"],
  [/burger|american|diner|southern|soul|barbecue|bbq|chicken|steak|cajun|grill/i, "burger"],
];

/** The drawing for the first word that matches, from the most specific source given first. */
export function cuisineFamily(...words: (string | null | undefined)[]): CuisineFamily {
  for (const w of words) {
    if (!w) continue;
    for (const [re, fam] of FAMILY) if (re.test(w)) return fam;
  }
  return "plate";
}

const BG: Record<CuisineFamily, string> = {
  pizza: "#f3d9c4",
  noodles: "#f1e3bf",
  sushi: "#dfe6dc",
  taco: "#f4dcb0",
  curry: "#f0d2b3",
  pita: "#e7e0c9",
  burger: "#efd8c2",
  sandwich: "#ece0c8",
  salad: "#d8e6c6",
  cup: "#e4d6c8",
  plate: "#e4e1d6",
};

const INK = "#3d3a33";
const S = { fill: "none", stroke: INK, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function Glyph({ f }: { f: CuisineFamily }) {
  switch (f) {
    case "pizza":
      return (
        <g>
          <path {...S} d="M12 14 L36 14 L24 38 Z" fill="#f2c36b" />
          <path {...S} d="M12 14 Q24 9 36 14" fill="#d98c4a" />
          <circle cx="21" cy="19" r="2.2" fill="#c4543c" />
          <circle cx="28" cy="20" r="2.2" fill="#c4543c" />
          <circle cx="24" cy="27" r="2" fill="#6e8f4e" />
        </g>
      );
    case "noodles":
      return (
        <g>
          <path {...S} d="M9 24 H39 Q38 36 24 37 Q10 36 9 24 Z" fill="#fffaf0" />
          <path {...S} d="M14 24 Q17 18 20 24 Q23 18 26 24 Q29 18 32 24" stroke="#c9952f" />
          <path {...S} d="M28 9 L20 22 M34 10 L24 22" />
        </g>
      );
    case "sushi":
      return (
        <g>
          <circle cx="17" cy="26" r="8" fill="#2f3b2e" />
          <circle cx="17" cy="26" r="5.5" fill="#fffaf0" />
          <circle cx="17" cy="26" r="2.4" fill="#e07b39" />
          <circle cx="32" cy="26" r="8" fill="#2f3b2e" />
          <circle cx="32" cy="26" r="5.5" fill="#fffaf0" />
          <circle cx="32" cy="26" r="2.4" fill="#7da453" />
        </g>
      );
    case "taco":
      return (
        <g>
          <path {...S} d="M8 32 Q8 14 24 14 Q40 14 40 32 Z" fill="#f2c36b" />
          <path {...S} d="M13 26 Q16 21 19 25 Q22 20 25 25 Q28 20 31 25 Q34 21 36 26" stroke="#5f8a3e" />
          <circle cx="20" cy="28" r="1.8" fill="#c4543c" />
          <circle cx="28" cy="28" r="1.8" fill="#c4543c" />
        </g>
      );
    case "curry":
      return (
        <g>
          <path {...S} d="M10 22 H38 V26 Q38 37 24 37 Q10 37 10 26 Z" fill="#d98c2f" />
          <path {...S} d="M8 22 H40" />
          <path {...S} d="M18 17 Q16 13 19 10 M25 17 Q23 13 26 10 M32 17 Q30 13 33 10" strokeWidth={1.6} />
          <circle cx="20" cy="28" r="1.6" fill="#fff3d6" />
          <circle cx="27" cy="30" r="1.6" fill="#6e8f4e" />
        </g>
      );
    case "pita":
      return (
        <g>
          <ellipse {...S} cx="24" cy="27" rx="15" ry="9" fill="#e9c98f" />
          <circle cx="18" cy="24" r="3" fill="#8a6a3f" />
          <circle cx="25" cy="22" r="3" fill="#8a6a3f" />
          <circle cx="31" cy="25" r="3" fill="#8a6a3f" />
          <path {...S} d="M15 30 Q24 34 33 30" stroke="#6e8f4e" />
        </g>
      );
    case "burger":
      return (
        <g>
          <path {...S} d="M11 22 Q11 11 24 11 Q37 11 37 22 Z" fill="#e0a252" />
          <path {...S} d="M10 26 Q15 23 19 26 Q24 23 28 26 Q33 23 38 26" stroke="#5f8a3e" />
          <rect x="11" y="27" width="26" height="4" rx="2" fill="#8a5a3f" />
          <path {...S} d="M11 33 H37 Q37 37 33 37 H15 Q11 37 11 33 Z" fill="#e0a252" />
        </g>
      );
    case "sandwich":
      return (
        <g>
          <path {...S} d="M9 30 L24 15 L39 30 Z" fill="#f4e3b5" />
          <path {...S} d="M12 30 Q18 27 24 30 Q30 27 36 30" stroke="#5f8a3e" />
          <path {...S} d="M9 30 H39 V34 H9 Z" fill="#e0b56f" />
        </g>
      );
    case "salad":
      return (
        <g>
          <path {...S} d="M9 24 H39 Q38 36 24 37 Q10 36 9 24 Z" fill="#fffaf0" />
          <path {...S} d="M14 24 Q14 15 22 16 Q20 22 14 24 Z" fill="#7da453" strokeWidth={1.4} />
          <path {...S} d="M34 24 Q34 14 25 15 Q27 22 34 24 Z" fill="#9dbf4a" strokeWidth={1.4} />
          <circle cx="24" cy="21" r="2.6" fill="#c4543c" />
        </g>
      );
    case "cup":
      return (
        <g>
          <path {...S} d="M13 18 H31 V30 Q31 36 22 36 Q13 36 13 30 Z" fill="#fffaf0" />
          <path {...S} d="M31 21 Q37 21 37 25.5 Q37 30 31 29" />
          <path {...S} d="M16 22 H28" stroke="#8a5a3f" strokeWidth={3} />
          <path {...S} d="M18 14 Q17 11 19 9 M24 14 Q23 11 25 9" strokeWidth={1.6} />
          <path {...S} d="M10 39 H34" />
        </g>
      );
    default:
      return (
        <g>
          <circle {...S} cx="25" cy="25" r="12" fill="#fffaf0" />
          <circle {...S} cx="25" cy="25" r="7.5" strokeWidth={1.4} />
          <path {...S} d="M8 12 V22 M6 12 V18 Q6 21 8 21 Q10 21 10 18 V12 M8 22 V38" strokeWidth={1.6} />
          <path {...S} d="M42 12 Q38 16 40 24 L42 24 V38" strokeWidth={1.6} />
        </g>
      );
  }
}

/** A square tile (40 px by default) with a drawing for the kind of food. Decorative: hidden from screen readers. */
export function CuisineMark({ family, size = 44 }: { family: CuisineFamily; size?: number }) {
  return (
    <span className="cmark" style={{ width: size, height: size, background: BG[family] }} data-family={family} aria-hidden="true">
      <svg viewBox="0 0 48 48" width={size} height={size} focusable="false">
        <Glyph f={family} />
      </svg>
    </span>
  );
}
