import { Suspense } from "react";
import Link from "next/link";
import { AppShell, Loading } from "@/components/app-shell";
import { DiaryTabs, PrivacyNote, SignInPanel } from "@/components/diary/diary-tabs";
import { GoalsForm } from "@/components/diary/goals-form";
import type { RawParams } from "@/lib/search-params";
import { getCurrentMember } from "@/server/auth/session";
import { getGoals } from "@/server/diary";
import { memberClock } from "@/server/diary/clock";
import { one } from "../params";

export const metadata = { title: "Goals" };
type Props = { searchParams: Promise<RawParams> };

async function GoalsBody({ searchParams }: Props) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  if (!member) return <SignInPanel next="/diary/goals">Sign in to set optional goals. They are visible only to you.</SignInPanel>;
  const clock = await memberClock();
  const goals = await getGoals(clock.today);
  return (
    <>
      <DiaryTabs active="goals" />
      {one(sp.done) === "saved" && (
        <p className="callout calm" role="status" data-testid="goals-saved">
          Goals saved. They apply from today. Earlier days keep the goal they had.
        </p>
      )}
      <p>
        Goals are optional and the numbers are yours to choose. We don&rsquo;t suggest or calculate targets, and there are no calorie or weight goals here.
      </p>
      <div className="panel">
        <GoalsForm goals={goals} key={`${goals.proteinPerDay?.target ?? ""}-${goals.homeMealsPerWeek?.target ?? ""}`} />
      </div>
      <p className="s14">
        See how the week is going in the{" "}
        <Link className="link" href="/diary/week">
          week view
        </Link>
        .
      </p>
      <h2 className="h-sec">Your data</h2>
      <p className="s14" style={{ marginTop: 0 }}>Download a copy of your own diary, goals and foods.</p>
      <div className="row">
        <a className="btn" href="/api/v1/me/export?format=csv" download>
          Diary as a spreadsheet (CSV)
        </a>
        <a className="btn" href="/api/v1/me/export?format=json" download>
          Everything (JSON)
        </a>
      </div>
      <PrivacyNote />
    </>
  );
}

export default function GoalsPage(props: Props) {
  return (
    <AppShell active="goals" narrow>
      <h1 className="title">Goals</h1>
      <Suspense fallback={<Loading />}>
        <GoalsBody {...props} />
      </Suspense>
    </AppShell>
  );
}
