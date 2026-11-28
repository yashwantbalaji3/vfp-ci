/**
 * Original vector food illustrations drawn by this code (design/d1-r2). They stand in
 * until rights-cleared photographs exist. Each one is labelled as an illustration and
 * is never presented as a photograph of a real restaurant dish.
 */
type Style = { bg: string; dish: string; base: string; bits: string[]; seed: number; square?: boolean; slab?: boolean };
const STYLES: Record<string, Style> = {
  bowl: { bg: "#e6d3ae", dish: "#f7f2e8", base: "#e9dcc0", bits: ["#d9a55b", "#d9a55b", "#6e8f4e", "#8e3b5b", "#e07b39", "#f1e6cc", "#6e8f4e"], seed: 7 },
  paneer: { bg: "#d9b8a0", dish: "#f4efe6", base: "#f4efe6", bits: ["#e9c79a", "#e9c79a", "#c2662f", "#b2477a", "#9dbf4a", "#e9c79a"], seed: 21, square: true },
  dal: { bg: "#c9b27a", dish: "#f2ece0", base: "#e3b23c", bits: ["#f4e3b5", "#4e7d3a", "#c2662f", "#4e7d3a"], seed: 33 },
  toast: { bg: "#cdbfa5", dish: "#f6f1e7", base: "#c99a5e", bits: ["#8a6a4f", "#a98566", "#8a6a4f", "#5f7f45", "#a98566"], seed: 45, slab: true },
  burger: { bg: "#bfc9a8", dish: "#f6f1e7", base: "#d59a4e", bits: ["#6b4a33", "#7da453", "#c94f3a", "#f1e6cc"], seed: 52 },
  soup: { bg: "#d8c3a0", dish: "#f7f2e8", base: "#d9772e", bits: ["#f0c27a", "#4e7d3a", "#f4e3b5", "#4e7d3a"], seed: 64 },
  tofu: { bg: "#c7d1bd", dish: "#f6f1e7", base: "#f6f1e7", bits: ["#f1e2bf", "#f1e2bf", "#f1e2bf", "#6e8f4e", "#c2662f"], seed: 71, square: true },
  crisp: { bg: "#d9cdb6", dish: "#f6f1e7", base: "#c9a36a", bits: ["#a9844f", "#e2c690", "#a9844f"], seed: 80, slab: true },
  salad: { bg: "#c3d0a5", dish: "#f7f2e8", base: "#cfe0a6", bits: ["#e07b39", "#c94f3a", "#6e8f4e", "#f1e6cc", "#6e8f4e"], seed: 91 },
  noodle: { bg: "#d6c3a3", dish: "#f7f2e8", base: "#e8c97f", bits: ["#6e8f4e", "#c94f3a", "#8a6a4f", "#e07b39"], seed: 99 },
};
const KEYWORDS: [RegExp, keyof typeof STYLES][] = [
  [/paneer|tikka/i, "paneer"],
  [/dal|lentil|sambar|idli/i, "dal"],
  [/toast|dosa|bread/i, "toast"],
  [/burger/i, "burger"],
  [/soup|stew|stock/i, "soup"],
  [/tofu|tempeh|bibimbap/i, "tofu"],
  [/crisp|cracker|bar\b/i, "crisp"],
  [/salad|papaya/i, "salad"],
  [/noodle|pasta/i, "noodle"],
];

export function illustrationStyleFor(name: string): string {
  for (const [pattern, key] of KEYWORDS) if (pattern.test(name)) return key;
  return "bowl";
}

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}
const f = (n: number) => Number(n.toFixed(2));

export function FoodIllustration({ name, size = "thumb" }: { name: string; size?: "thumb" | "hero" }) {
  const d = STYLES[illustrationStyleFor(name)];
  const r = rng(d.seed);
  const bits = d.bits.map((color, i) => {
    const a = (i / d.bits.length) * Math.PI * 2 + r() * 0.8;
    const dist = 6 + r() * 15;
    const x = f(50 + Math.cos(a) * dist);
    const y = f(50 + Math.sin(a) * dist);
    const s = f(5 + r() * 6);
    const rot = f(r() * 60);
    return d.square ? (
      <rect key={i} x={f(x - s)} y={f(y - s)} width={f(s * 1.8)} height={f(s * 1.8)} rx="2" fill={color} transform={`rotate(${rot} ${x} ${y})`} />
    ) : (
      <circle key={i} cx={x} cy={y} r={s} fill={color} />
    );
  });
  return (
    <div className={`ill ${size}`}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Illustration, not a photograph of this food">
        <rect width="100" height="100" fill={d.bg} />
        <circle cx="52" cy="54" r="36" fill="rgba(0,0,0,.08)" />
        <circle cx="50" cy="50" r="35" fill={d.dish} />
        <circle cx="50" cy="50" r="30" fill="none" stroke="rgba(0,0,0,.06)" strokeWidth="1.5" />
        {d.slab ? <rect x="22" y="30" width="56" height="40" rx="9" fill={d.base} /> : <circle cx="50" cy="50" r="27" fill={d.base} />}
        {bits}
      </svg>
      <span className="tag">{size === "hero" ? "Illustration · photo pending" : "Illustration"}</span>
    </div>
  );
}
