import Link from "next/link";
import type { DietPreference } from "@/contracts/catalog";
import { describeDietChoice, hasDietChoice } from "@/domain/dietary/labels";
import { Icon } from "./icons";

/** The visitor's dietary filter, shown the same way on every catalog page, with one way to change it. */
export function DietChip({ diet, returnTo }: { diet: DietPreference; returnTo: string }) {
  const chosen = hasDietChoice(diet);
  return (
    <Link className={`chip ${chosen ? "on" : ""}`} href={`/diet?return=${encodeURIComponent(returnTo)}`} data-testid="diet-chip">
      <Icon name="filter" className="" />
      <span>
        <span className="sr-only">Dietary filter: </span>
        {describeDietChoice(diet)}
        <span aria-hidden="true"> · </span>
        <span>{chosen ? "Change" : "Choose"}</span>
      </span>
    </Link>
  );
}
