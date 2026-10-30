import { Button } from '@packages/ui';
import { ArrowUpRight } from 'lucide-react';

export function OpenCorner({ size = 'default' }: { size?: 'default' | 'lg' }) {
  return (
    <Button render={<a href="/open-app" />} nativeButton={false} role="link" size={size}>
      Open Corner <ArrowUpRight aria-hidden="true" />
    </Button>
  );
}
