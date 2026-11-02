'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { requestSync } from '@/app/actions';
import { NAV_ITEMS } from './nav';

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** `g` then a letter jumps to a page; `r` syncs now. Ignored while typing. */
export function KeyboardShortcuts() {
  const router = useRouter();

  useEffect(() => {
    let awaitingG = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (awaitingG) {
        awaitingG = false;
        clearTimeout(timer);
        const item = NAV_ITEMS.find((i) => i.key === e.key);
        if (item) {
          e.preventDefault();
          router.push(item.href);
        }
        return;
      }
      if (e.key === 'g') {
        awaitingG = true;
        timer = setTimeout(() => (awaitingG = false), 1000);
      } else if (e.key === 'r') {
        e.preventDefault();
        void requestSync().then(() => router.refresh());
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      clearTimeout(timer);
    };
  }, [router]);

  return null;
}
