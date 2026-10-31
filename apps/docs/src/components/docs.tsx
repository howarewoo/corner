import type { ReactNode } from 'react';
import { type SerializedPageTree, useFumadocsLoader } from 'fumadocs-core/source/client';
import type { TOCItemType } from 'fumadocs-core/toc';
import { RootProvider } from 'fumadocs-ui/provider/astro';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from 'fumadocs-ui/layouts/docs/page';
import DocsSearch from './search';
import { Button } from '@packages/ui';

interface DocsProps {
  pathname: string;
  params: Record<string, string | undefined>;
  tree: SerializedPageTree;
  title: string;
  description?: string;
  toc: TOCItemType[];
  children?: ReactNode;
}

export function Docs({ tree, title, description, toc, children, pathname, params }: DocsProps) {
  const data = useFumadocsLoader({ tree });

  return (
    <RootProvider
      pathname={pathname}
      params={params}
      theme={{ enabled: false }}
      search={{ SearchDialog: DocsSearch }}
    >
      <DocsLayout
        tree={data.tree}
        nav={{ title: 'Corner / Guide', url: '/' }}
        links={[
          {
            type: 'custom',
            children: (
              <Button
                render={<a href="/open-app" />}
                nativeButton={false}
                role="link"
                variant="outline"
              >
                Open Corner
              </Button>
            ),
          },
        ]}
        themeSwitch={{ enabled: false }}
        tabs={false}
        sidebar={{ collapsible: false }}
      >
        <DocsPage toc={toc} id="main" tabIndex={-1}>
          <DocsTitle>{title}</DocsTitle>
          <DocsDescription>{description}</DocsDescription>
          <DocsBody>{children}</DocsBody>
        </DocsPage>
      </DocsLayout>
    </RootProvider>
  );
}
