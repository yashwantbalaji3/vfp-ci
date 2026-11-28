import Link from "next/link";
import { toggleSaveAction } from "@/app/actions/member";
import { getCurrentMember } from "@/server/auth/session";
import { isSaved, type SaveTarget } from "@/server/member/saves";
import { CorrectionForm } from "./correction-form";
import { Icon } from "./icons";

const SAVED_WORDS: Record<string, string> = {
  saved: "Saved. Only you can see your saved list.",
  removed: "Removed from your saved list.",
  failed: "We couldn't update your saved list. Please try again.",
  wait: "That was a lot of presses in a short time. Nothing changed. Please wait a minute and try again.",
};

/** Save button plus "Report a problem". Guests see the same controls; pressing them leads to sign-in and back. */
/** `corrections={false}` leaves out the correction form, for real places, which have their own "Report a problem". */
export async function MemberActions({ target, returnTo, outcome, corrections = true }: { target: SaveTarget; returnTo: string; outcome?: string; corrections?: boolean }) {
  const member = await getCurrentMember();
  const saved = member ? await isSaved(target) : false;
  const ids = "foodItemId" in target ? { foodItemId: target.foodItemId } : { venueId: target.venueId };
  return (
    <>
      <form action={toggleSaveAction}>
        <input type="hidden" name="return" value={returnTo} />
        {"foodItemId" in target ? (
          <input type="hidden" name="foodItemId" value={target.foodItemId} />
        ) : (
          <input type="hidden" name="venueId" value={target.venueId} />
        )}
        <button className={`btn ${saved ? "" : "primary"}`} type="submit" aria-pressed={saved} data-testid="save-button">
          <Icon name="save" className="" />
          {saved ? "Saved · Remove" : "Save"}
        </button>
        {!member && (
          <p className="s13 muted" style={{ margin: "4px 0 0" }}>
            Saving needs an account. You&rsquo;ll come back to this page after signing in.
          </p>
        )}
      </form>
      <p role="status" aria-live="polite" className="s14" style={{ margin: "8px 0 0" }} data-testid="save-status">
        {member && outcome ? (SAVED_WORDS[outcome] ?? "") : ""}
      </p>
      {corrections && (
        <details className="sheet" style={{ marginTop: 16 }}>
          <summary>Report a problem with this page</summary>
        <div className="sheet-body">
          {member ? (
            <CorrectionForm {...ids} />
          ) : (
            <p style={{ margin: 0 }}>
              <Link className="link" href={`/login?next=${encodeURIComponent(returnTo)}`}>
                Sign in to send a correction
              </Link>
              . We ask for an account so corrections can be reviewed fairly.
            </p>
          )}
        </div>
        </details>
      )}
    </>
  );
}
