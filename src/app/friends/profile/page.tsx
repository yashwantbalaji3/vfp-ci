import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { saveProfileAction } from "@/app/social/actions";
import { Flash, PrivacyPromise, SignInPrompt, SocialNav } from "@/components/social/bits";
import { describeDietChoice, hasDietChoice } from "@/domain/dietary/labels";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { readDietPreference } from "@/server/catalog/diet";
import { getMyProfile } from "@/server/social";

export const metadata = { title: "My profile" };

async function ProfileForm({ searchParams }: { searchParams: Promise<RawParams> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) {
    return (
      <SignInPrompt next="/friends/profile">
        <p>Sign in to set up your profile.</p>
      </SignInPrompt>
    );
  }
  const [me, diet] = await Promise.all([getMyProfile(), readDietPreference()]);
  const p = me.profile;
  return (
    <>
      <SocialNav active="profile" requests={me.incomingRequests} />
      <Flash sp={sp} />
      {me.profileHidden && (
        <p className="callout stop">A moderator has hidden your profile and posts from other people. You can still use the rest of the app.</p>
      )}
      {p ? (
        <p>
          <Link className="link" href={`/u/${p.handle}`} data-testid="view-my-profile">
            See your profile as others see it
          </Link>{" "}
          · {p.followerCount} {p.followerCount === 1 ? "follower" : "followers"} · following {p.followingCount}
        </p>
      ) : (
        <p className="lede">A profile is how other people see you. It needs only a handle. Everything else is optional.</p>
      )}
      <form action={saveProfileAction} className="panel stack" data-testid="profile-form">
        <input type="hidden" name="return" value="/friends/profile" />
        <div>
          <label htmlFor="pf-handle">Handle</label>
          <input id="pf-handle" type="text" name="handle" defaultValue={p?.handle ?? ""} required minLength={3} maxLength={30} pattern="[a-zA-Z0-9_]{3,30}" autoCapitalize="none" autoComplete="off" aria-describedby="pf-handle-hint" />
          <p className="s13 muted" id="pf-handle-hint" style={{ margin: "4px 0 0" }}>
            3 to 30 letters, numbers or underscores. This is how people find you, so avoid your full name if you prefer.
          </p>
        </div>
        <div>
          <label htmlFor="pf-name">Display name (optional)</label>
          <input id="pf-name" type="text" name="displayName" defaultValue={p?.displayName ?? ""} maxLength={80} autoComplete="off" />
        </div>
        <div>
          <label htmlFor="pf-bio">About you (optional)</label>
          <textarea id="pf-bio" name="bio" defaultValue={p?.bio ?? ""} maxLength={300} rows={3} />
        </div>
        <div>
          <label htmlFor="pf-tastes">Tastes (optional)</label>
          <input id="pf-tastes" type="text" name="tasteTags" defaultValue={p?.tasteTags.join(", ") ?? ""} maxLength={220} aria-describedby="pf-tastes-hint" autoComplete="off" />
          <p className="s13 muted" id="pf-tastes-hint" style={{ margin: "4px 0 0" }}>
            Up to 8, separated by commas. For example: spicy, south indian, tofu.
          </p>
        </div>
        <fieldset>
          <legend>What others can see</legend>
          <label className="check">
            <input type="checkbox" name="discoverable" defaultChecked={p?.discoverable ?? false} />
            <span>
              Let people find me by my exact handle
              <span className="hint">Off: you don&rsquo;t appear in search or suggestions, and only people you follow can send you a friend request.</span>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" name="showTastes" defaultChecked={p?.showTastes ?? false} />
            <span>
              Show my tastes on my profile
              <span className="hint">Off: only you can see them.</span>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" name="showDiet" defaultChecked={p?.showDiet ?? false} />
            <span>
              Show my diet on my profile
              <span className="hint">
                {diet.diet === "none"
                  ? "You have no diet chosen, so nothing would be shown."
                  : `Would show “${describeDietChoice({ diet: diet.diet, exclusions: [] })}” only.`}{" "}
                {hasDietChoice(diet) && diet.exclusions.length > 0 ? "Ingredients you leave out are never shown, because they can reveal an allergy." : "Ingredients you leave out are never shown."}
              </span>
            </span>
          </label>
        </fieldset>
        <p className="s14 muted" style={{ margin: 0 }}>
          Always visible on a profile: your handle, name, about text, and how many people follow you and you follow. Never visible: who those people are.
        </p>
        <button className="btn primary" type="submit">
          Save profile
        </button>
      </form>
      <PrivacyPromise />
    </>
  );
}

export default function Page({ searchParams }: { searchParams: Promise<RawParams> }) {
  return (
    <AppShell active="friends" narrow>
      <h1 className="title">My profile</h1>
      <Suspense fallback={<Loading />}>
        <ProfileForm searchParams={searchParams} />
      </Suspense>
    </AppShell>
  );
}
