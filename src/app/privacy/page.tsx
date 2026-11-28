import { LegalPage } from "@/components/legal-page";
import { PRIVACY } from "@/content/legal";

export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return <LegalPage title="Privacy" sections={PRIVACY} testId="privacy-text" />;
}
