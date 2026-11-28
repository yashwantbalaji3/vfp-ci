import { Suspense } from "react";
import { connection } from "next/server";
import { notFound } from "next/navigation";

/**
 * Test-only page that fails on purpose, so the browser tests can prove the app shows
 * its own error screen with no technical detail (R1 acceptance test 4). It exists only
 * where ALLOW_FAULT_TEST=true, which the local environment sets and a hosted one never
 * does; everywhere else this address is an ordinary "not found".
 */
async function Fault(): Promise<never> {
  await connection();
  if (process.env.ALLOW_FAULT_TEST !== "true") notFound();
  throw new Error("Forced fault for the error-page test: secret-detail-that-must-not-be-shown");
}

export default function FaultPage() {
  return (
    <Suspense fallback={null}>
      <Fault />
    </Suspense>
  );
}
