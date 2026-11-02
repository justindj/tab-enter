import { ComingSoon } from '@/components/empty-state';

export default function VerificationPage() {
  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <h1 className="text-lg font-semibold">Verification</h1>
      <ComingSoon milestone="M6">
        Playwright verification jobs for completed tickets, walkthrough scripts generated once and
        re-run for free, and a self-contained slideshow artifact per ticket.
      </ComingSoon>
    </div>
  );
}
