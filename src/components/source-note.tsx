import type { Source } from "@/contracts/catalog";
import { formatDate, titleCase } from "@/lib/format";

/** Where a fact came from, one action away from the fact itself (R-005). */
export function SourceNote({ source, checkedAt, expiresAt, label = "Source" }: { source: Source; checkedAt?: string | null; expiresAt?: string | null; label?: string }) {
  if (!source) return <span className="s13 muted">No source on file</span>;
  const safeUrl = source.url && /^https:\/\//.test(source.url) ? source.url : null;
  return (
    <details className="src">
      <summary>{label}</summary>
      <div className="src-body">
        <p style={{ margin: 0 }}>
          <strong>{source.publisher ?? "Unnamed source"}</strong>
          {source.sourceType ? ` · ${titleCase(source.sourceType)}` : ""}
        </p>
        {source.summary && <p style={{ margin: "4px 0 0" }}>{source.summary}</p>}
        <p style={{ margin: "4px 0 0" }}>
          {formatDate(checkedAt ?? source.observedAt) ? `Checked ${formatDate(checkedAt ?? source.observedAt)}. ` : "Check date not recorded. "}
          {expiresAt ? `Due for re-check ${formatDate(expiresAt)}.` : ""}
        </p>
        {safeUrl && (
          <p style={{ margin: "4px 0 0" }}>
            <a className="link" href={safeUrl} rel="noopener noreferrer nofollow" target="_blank">
              Open the source (new tab)
            </a>
          </p>
        )}
        {source.isDemo && <p style={{ margin: "4px 0 0" }}>Demo source: invented for testing, not a real statement.</p>}
      </div>
    </details>
  );
}
