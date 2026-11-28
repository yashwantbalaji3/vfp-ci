import { LegalPage } from "@/components/legal-page";
import { TERMS } from "@/content/legal";

export const metadata = { title: "Terms" };

export default function TermsPage() {
  return <LegalPage title="Terms" sections={TERMS} testId="terms-text" />;
}
