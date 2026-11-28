import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getClaimTarget } from "@/server/partner";
import { SocialError } from "@/server/social";
import { claimPlaceAction } from "../../actions";
import { partnerError } from "../../words";

export const metadata = { title: "Manage a restaurant", robots: { index: false, follow: false } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function ClaimForm({ params, searchParams }: { params: Promise<{ candidateId: string }>; searchParams: Promise<RawParams> }) {
  const [{ candidateId }, sp] = await Promise.all([params, searchParams]);
  if (!UUID.test(candidateId)) notFound();
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next={`/partner/claim/${candidateId}`}>
        <p>Sign in to ask to manage this restaurant&rsquo;s menu information.</p>
      </SignInPrompt>
    );
  }
  let target: Awaited<ReturnType<typeof getClaimTarget>>;
  try {
    target = await getClaimTarget(candidateId);
  } catch (e) {
    if (e instanceof SocialError && e.status === 404) notFound();
    throw e;
  }
  const err = partnerError(first(sp.e));
  return (
    <section className="post" data-testid="partner-claim-form">
      <h2 className="h-sec" style={{ marginTop: 0, overflowWrap: "anywhere" }} data-testid="partner-claim-place">
        {target.name}
      </h2>
      <p className="s14 muted" style={{ margin: "0 0 12px" }}>
        {[target.street, target.postcode].filter(Boolean).join(" · ")}
      </p>
      {target.myClaim ? (
        <p className="callout calm" role="status">
          You have already asked to manage this place. <Link href="/partner">See its status</Link>.
        </p>
      ) : (
        <form action={claimPlaceAction} className="stack">
          {err && (
            <p className="callout stop" role="alert" data-testid="partner-error">
              {err}
            </p>
          )}
          <input type="hidden" name="candidateId" value={target.candidateId} />
          <div>
            <label htmlFor="claim-role">Your role at the restaurant</label>
            <input id="claim-role" name="roleTitle" required minLength={2} maxLength={100} autoComplete="organization-title" style={{ width: "100%", minHeight: 44 }} />
          </div>
          <div>
            <label htmlFor="claim-email">Email we can reach you at</label>
            <input id="claim-email" name="email" type="email" required maxLength={254} autoComplete="email" style={{ width: "100%", minHeight: 44 }} aria-describedby="claim-email-help" />
            <p id="claim-email-help" className="s14 muted" style={{ margin: "4px 0 0" }}>
              An address at the restaurant&rsquo;s own website domain makes the ownership check quickest. We use it only to check ownership and about your menu.
            </p>
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" name="confirmed" value="yes" required />
            <span>I am authorised to act for this restaurant.</span>
          </label>
          <p className="s14 muted" style={{ margin: 0 }}>
            Next, a moderator checks that you represent the restaurant (for example by email at its website domain, a code by post, or a call to its public number). Until then,
            nothing you send is used.
          </p>
          <button className="btn primary" type="submit" data-testid="partner-claim-send">
            Ask to manage this restaurant
          </button>
        </form>
      )}
    </section>
  );
}

export default function ClaimPage({ params, searchParams }: { params: Promise<{ candidateId: string }>; searchParams: Promise<RawParams> }) {
  if (!FLAGS.partnerSubmissions) notFound();
  return (
    <AppShell active="account">
      <p className="eyebrow">Private · for restaurants</p>
      <h1 className="title">Manage a restaurant</h1>
      <Suspense fallback={<Loading label="Loading…" />}>
        <ClaimForm params={params} searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
