import { ComingSoon } from '@/components/empty-state';

export default function CommunicationPage() {
  return (
    <div className="mx-auto grid max-w-6xl gap-5">
      <h1 className="text-lg font-semibold">Communication</h1>
      <ComingSoon milestone="M4">
        A daily report (Done / In progress / Next / Blockers) and a review-request message,
        generated from templates with no AI, editable, in Slack mrkdwn or plain text, with one-key
        copy and history.
      </ComingSoon>
    </div>
  );
}
