import type { ReactNode } from 'react';

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="specimen-section">
      <div className="specimen-heading">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="specimen-preview">{children}</div>
    </section>
  );
}

export function Status({ children }: { children: ReactNode }) {
  return (
    <p className="specimen-status" role="status">
      {children}
    </p>
  );
}
