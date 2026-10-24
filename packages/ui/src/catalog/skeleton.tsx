// Adapted from current shadcn base-nova; license/source digests: ../../NOTICE, ../../provenance.json.
import { cn } from '../lib/utils';
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  );
}
export { Skeleton };
