import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, Loading } from "@/components/app-shell";
import { SignInPrompt } from "@/components/social/bits";
import { FLAGS } from "@/config/flags";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getLicence, getMyClaims } from "@/server/partner";
import { uploadMenuAction } from "../../actions";
import { partnerError } from "../../words";

export const metadata = { title: "Send a menu", robots: { index: false, follow: false } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const COLUMNS = "name, description, section, labels, ingredients, allergens, price_usd, serving, serving_grams, calories_kcal, protein_g, carb_g, fat_g, fiber_g, sodium_mg, sugar_g";

async function Upload({ params, searchParams }: { params: Promise<{ claimId: string }>; searchParams: Promise<RawParams> }) {
  const [{ claimId }, sp] = await Promise.all([params, searchParams]);
  if (!UUID.test(claimId)) notFound();
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next={`/partner/${claimId}/upload`}>
        <p>Sign in to send a menu.</p>
      </SignInPrompt>
    );
  }
  const [claims, licence] = await Promise.all([getMyClaims(), getLicence()]);
  // Only the claimant sees this page; anyone else gets "not found", and the database refuses them anyway.
  const claim = claims.find((c) => c.claimId === claimId);
  if (!claim) notFound();
  const err = partnerError(first(sp.e));
  if (claim.state !== "verified") {
    return (
      <div className="empty" data-testid="partner-upload-blocked">
        <h2>Not yet</h2>
        <p>A menu can be sent once a moderator has checked that you represent {claim.placeName}.</p>
        <p>
          <Link href="/partner">Back to your restaurants</Link>
        </p>
      </div>
    );
  }
  return (
    <section className="post" data-testid="partner-upload">
      <h2 className="h-sec" style={{ marginTop: 0, overflowWrap: "anywhere" }}>
        {claim.placeName}
      </h2>
      <form action={uploadMenuAction} className="stack" encType="multipart/form-data">
        {err && (
          <p className="callout stop" role="alert" data-testid="partner-error">
            {err}
          </p>
        )}
        <input type="hidden" name="claimId" value={claim.claimId} />
        <input type="hidden" name="licence" value={licence.version} />
        <div>
          <label htmlFor="upload-file">Menu file (.csv or .json, up to 512 KB)</label>
          <input id="upload-file" name="file" type="file" accept=".csv,.json,text/csv,application/json" required aria-describedby="upload-file-help" />
          <div id="upload-file-help" className="s14 muted" style={{ marginTop: 4 }}>
            <p style={{ margin: "0 0 4px" }}>One dish per row. The columns we read are: {COLUMNS}.</p>
            <p style={{ margin: "0 0 4px" }}>
              Leave a cell blank when you don&rsquo;t know a value: we never fill it in, and blank is never treated as zero. Calories are in kcal, sodium in mg, and the
              other nutrients in grams, per serving.
            </p>
            <p style={{ margin: 0 }}>
              Separate labels with a semicolon. Only a label that says exactly &ldquo;vegan&rdquo; or &ldquo;vegetarian&rdquo; is recorded as your dietary statement, in your
              own words. Other labels are kept for a person to read.
            </p>
          </div>
        </div>
        <div>
          <label htmlFor="upload-date">Date of this menu (optional)</label>
          <input id="upload-date" name="documentDate" type="date" />
        </div>
        <fieldset>
          <legend>Permission (version {licence.version})</legend>
          <p className="s14" style={{ margin: "0 0 8px" }} data-testid="partner-licence">
            {licence.text}
          </p>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" name="accept" value="yes" required data-testid="partner-accept" />
            <span>I accept this on behalf of the restaurant.</span>
          </label>
        </fieldset>
        <button className="btn primary" type="submit" data-testid="partner-upload-send">
          Send for review
        </button>
      </form>
    </section>
  );
}

export default function UploadPage({ params, searchParams }: { params: Promise<{ claimId: string }>; searchParams: Promise<RawParams> }) {
  if (!FLAGS.partnerSubmissions) notFound();
  return (
    <AppShell active="account">
      <p className="eyebrow">Private · for restaurants</p>
      <h1 className="title">Send a menu</h1>
      <p className="s14 muted" style={{ marginTop: 0 }}>
        A moderator checks every dish before anything is used. Nothing you send is shown publicly by itself.
      </p>
      <Suspense fallback={<Loading label="Loading…" />}>
        <Upload params={params} searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
