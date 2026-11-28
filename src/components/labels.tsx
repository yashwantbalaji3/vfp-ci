import type { Basis, Eligibility, ProteinFacts } from "@/contracts/catalog";
import { confidenceLabel, type ConfidenceLabel, type DietChoice } from "@/domain/dietary/labels";
import { formatAmount, methodLabel, proteinFor, proteinRangeFor, reasonText } from "@/lib/format";
import { Icon } from "./icons";

export function Confidence({ label }: { label: ConfidenceLabel }) {
  return (
    <span className={`conf ${label.tone}`}>
      <Icon name={label.tone} className="" />
      {label.text}
    </span>
  );
}

/** Dietary confidence for one result against the visitor's own filter. Nothing is shown when no filter is chosen. */
export function DietaryConfidence({ eligibility, choice }: { eligibility: Eligibility; choice: DietChoice }) {
  if (choice.diet === "none" && choice.exclusions.length === 0) return null;
  return <Confidence label={confidenceLabel(eligibility.status, eligibility.reasons, choice)} />;
}

/** Says how a number was obtained. "Not provided" is a first-class answer. */
export function EvidenceBadge({ method, known }: { method: string | null; known: boolean }) {
  return (
    <span className={`ev ${known ? "" : "unknown"}`}>
      <Icon name="source" className="" />
      <span className="sr-only">Evidence: </span>
      {known ? methodLabel(method) : "Not provided"}
    </span>
  );
}

/**
 * Protein with its basis. A missing value is worded, never drawn as 0. An estimate is never drawn as a
 * measurement: it reads "about", and the evidence badge beside it says "Estimated" (owner, 18:17 UTC 16 Nov).
 */
export function ProteinFigure({ protein, basis = "serving", large = false }: { protein: ProteinFacts; basis?: Basis; large?: boolean }) {
  const view = proteinFor(protein, basis);
  const range = proteinRangeFor(protein, basis);
  if (view.value === null) {
    return (
      <span className="pro none" data-testid="protein-figure">
        <span className="v">{reasonText(view.reason)}</span>
      </span>
    );
  }
  return (
    <span className={`pro ${large ? "lg" : ""}`} data-testid="protein-figure" data-estimated={protein.method === "estimated" ? "true" : undefined}>
      {protein.method === "estimated" && <span className="per">about </span>}
      <span className="v">{formatAmount(view.value)}</span> <span className="u">g protein</span> <span className="per">{view.per}</span>
      {protein.method === "estimated" && (
        <span className="per" data-testid="protein-range">
          {range ? `(estimate ${formatAmount(range.low)}–${formatAmount(range.high)} g)` : "(estimate)"}
        </span>
      )}
    </span>
  );
}
