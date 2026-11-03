import { getDb, getVerification } from '@tab-enter/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { loadApp } from '@/lib/data';
import { timeAgo } from '@/lib/format';
import { CopySummary } from '../controls';
import { STATUS } from '../status';

export default async function VerificationArtifactPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { active, now } = await loadApp();
  const v = await getVerification(await getDb(), id);
  if (!v || v.profileId !== active.id) notFound();

  return (
    <div className="mx-auto grid max-w-6xl gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/verification" className="text-xs text-muted-foreground hover:underline">
          ← Verification
        </Link>
        <h1 className="text-lg font-semibold">{v.issueKey}</h1>
        <Badge tone={STATUS[v.status].tone}>{STATUS[v.status].label}</Badge>
        <span className="text-xs text-muted-foreground">
          {timeAgo(v.finishedAt ?? v.createdAt, now)}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {v.summary && <CopySummary text={v.summary} />}
          {v.blobKey && (
            <a
              href={`/verification/${v.id}/artifact?download`}
              className={buttonVariants({ size: 'sm', variant: 'outline' })}
            >
              Download HTML
            </a>
          )}
        </span>
      </div>
      {v.blobKey ? (
        <iframe
          src={`/verification/${v.id}/artifact`}
          title={`${v.issueKey} verification slideshow`}
          sandbox="allow-scripts allow-modals"
          className="h-[78vh] w-full rounded-lg border bg-white"
        />
      ) : (
        <p className="text-sm text-muted-foreground">{v.error ?? 'No slideshow yet.'}</p>
      )}
      <p className="text-xs text-muted-foreground">
        Use the arrow keys inside the slideshow. Print or save as PDF from its toolbar (one slide
        per page). The downloaded file works offline.
      </p>
    </div>
  );
}
