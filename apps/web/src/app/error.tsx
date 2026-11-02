'use client';

import { Button } from '@/components/ui/button';

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto mt-16 max-w-lg rounded-lg border bg-card p-6">
      <h1 className="font-semibold">Something went wrong</h1>
      <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
      <Button className="mt-4" variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
