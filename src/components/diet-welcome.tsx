import Link from "next/link";
import { saveDietPreference } from "@/app/diet/actions";
import { getCurrentMember } from "@/server/auth/session";
import { readSavedDiet } from "@/server/catalog/diet";

/**
 * The first-run dietary question (docs/05 A7; audit A1-9). A signed-in member who has
 * never saved a dietary filter is asked once, in plain words, where they land after
 * signing in. Either answer is saved to their account, so the question does not come
 * back. Nothing is assumed for them: until they answer, no filter is applied and the
 * chip on every page says so.
 */
export async function DietWelcome({ returnTo }: { returnTo: string }) {
  const member = await getCurrentMember();
  if (!member) return null;
  if ((await readSavedDiet()) !== null) return null;
  const quick = (diet: "vegetarian" | "vegan", label: string) => (
    <form action={saveDietPreference}>
      <input type="hidden" name="return" value={returnTo} />
      <input type="hidden" name="diet" value={diet} />
      <button className="chip" type="submit" data-testid={`diet-welcome-${diet}`}>
        {label}
      </button>
    </form>
  );
  return (
    <section className="diet-welcome" aria-labelledby="diet-welcome-title" data-testid="diet-welcome">
      <h2 className="s16" id="diet-welcome-title" style={{ margin: 0 }}>
        How do you eat?
      </h2>
      <p className="s13 muted" style={{ margin: "2px 0 8px" }}>
        Pick once and every list shows only food stated to fit. Only you can see your answer, and you can change it any time.
      </p>
      <div className="chips">
        {quick("vegetarian", "Vegetarian")}
        {quick("vegan", "Vegan")}
        <Link className="chip" href={`/diet?return=${encodeURIComponent(returnTo)}`} data-testid="diet-welcome-choose">
          More choices…
        </Link>
        <form action={saveDietPreference}>
          <input type="hidden" name="return" value={returnTo} />
          <input type="hidden" name="diet" value="none" />
          <button className="chip quiet" type="submit" data-testid="diet-welcome-none">
            Show everything
          </button>
        </form>
      </div>
    </section>
  );
}
