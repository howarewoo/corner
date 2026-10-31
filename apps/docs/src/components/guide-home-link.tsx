import { Button } from '@packages/ui';

export function GuideHomeLink() {
  return (
    <Button render={<a href="/" />} nativeButton={false} role="link">
      Back to the guide
    </Button>
  );
}
