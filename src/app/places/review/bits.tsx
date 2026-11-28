export function FounderOnly() {
  return (
    <div className="empty" data-testid="review-founder-only">
      <h2>This page is for the founder</h2>
      <p>Identity review is open only to the founder account.</p>
    </div>
  );
}

export function Progress({ label, done, total, testId }: { label: string; done: number; total: number; testId?: string }) {
  return (
    <div data-testid={testId}>
      <p style={{ margin: "0 0 4px" }}>
        <strong>{label}:</strong> {done} of {total} checked
      </p>
      <progress value={done} max={Math.max(total, 1)} style={{ width: "100%" }} aria-label={`${label}: ${done} of ${total} checked`} />
    </div>
  );
}
