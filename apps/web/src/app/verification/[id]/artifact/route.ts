import { getActiveProfile, getDataDir, getDb, getVerification } from '@tab-enter/db';
import { FileBlobStore } from '@tab-enter/db/blob-store';

// Serves a verification slideshow (self-contained HTML) from the blob store.
// The page may only show inline images/styles and run its own inline
// navigation script: no network, so a slideshow can't call anything.

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const profile = await getActiveProfile(db);
  const row = await getVerification(db, id);
  if (!row || row.profileId !== profile?.id || !row.blobKey) {
    return new Response('Not found', { status: 404 });
  }
  const data = await new FileBlobStore(getDataDir()).get(row.blobKey);
  if (!data) return new Response('The slideshow file is missing.', { status: 404 });
  const download = new URL(request.url).searchParams.has('download');
  return new Response(Buffer.from(data), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy':
        "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'",
      'X-Content-Type-Options': 'nosniff',
      ...(download
        ? { 'Content-Disposition': `attachment; filename="${row.issueKey}-verification.html"` }
        : {}),
    },
  });
}
