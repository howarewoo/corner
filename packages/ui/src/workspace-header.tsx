import type { ComponentProps, ReactElement, ReactNode, Ref } from 'react';
import { Button } from './primitives';

export type WorkspaceHeaderProps = Omit<ComponentProps<'header'>, 'title'> & {
  title: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  titleRef?: Ref<HTMLHeadingElement>;
};

export function WorkspaceHeader({ title, actions, eyebrow, description, titleRef, className, ...props }: WorkspaceHeaderProps) {
  return <header data-slot="workspace-header" className={className ? `ui-workspace-header ${className}` : 'ui-workspace-header'} {...props}>
    <div className="ui-workspace-header-copy">
      {eyebrow && <div className="ui-workspace-header-eyebrow">{eyebrow}</div>}
      <h1 className="ui-workspace-header-title" ref={titleRef} tabIndex={-1}>{title}</h1>
      {description && <p className="ui-workspace-header-description">{description}</p>}
    </div>
    {actions && <div className="ui-workspace-header-actions">{actions}</div>}
  </header>;
}

export type WorkspaceMobileBarProps = Omit<ComponentProps<'header'>, 'children'> & {
  homeLabel: string;
  onHome: () => void;
  homeLink?: ReactElement;
  actions?: ReactNode;
};

export function WorkspaceMobileBar({
  homeLabel,
  onHome,
  homeLink,
  actions,
  className,
  ...props
}: WorkspaceMobileBarProps) {
  return (
    <header
      data-slot="workspace-mobile-bar"
      className={className ? `ui-workspace-mobile-bar ${className}` : 'ui-workspace-mobile-bar'}
      {...props}
    >
      <Button
        variant="ghost"
        className="ui-app-sidebar-brand ui-workspace-mobile-brand"
        aria-label={homeLabel}
        render={homeLink}
        nativeButton={!homeLink}
        role={homeLink ? 'link' : undefined}
        onClick={homeLink ? undefined : onHome}
      >
        <span className="ui-app-sidebar-brand-mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>
          corner<span className="ui-app-sidebar-brand-period">.</span>
        </span>
      </Button>
      {actions && <div className="ui-workspace-mobile-bar-actions">{actions}</div>}
    </header>
  );
}
