import { useState } from 'react';
import { cn } from '@/lib/utils';
import { splitFirstSentence } from '@/lib/watchTracking';

/** A help text cut to its first sentence, with the rest behind "More". */
export function MoreText({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [first, rest] = splitFirstSentence(text);
  return (
    <p className={cn('text-[11px] text-muted-foreground', className)}>
      {first}
      {rest ? (
        <>
          {open ? ` ${rest}` : null}{' '}
          <button type="button" className="text-primary underline-offset-2 hover:underline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Less' : 'More'}
          </button>
        </>
      ) : null}
    </p>
  );
}
