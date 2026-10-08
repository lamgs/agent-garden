import type { ReactNode } from 'react';

/** Page chrome for the M4 views: a way back, a title, and the keys that stay one press away. */
export function PageShell({
  crumb,
  children,
  table,
}: {
  crumb: string;
  children: ReactNode;
  /** Whether `T` jumps to this page's table. */
  table?: boolean;
}) {
  return (
    <div className="page" data-page>
      <nav className="page-bar" aria-label="Page">
        <a href="#/" className="back-link">
          ← Garden
        </a>
        <span className="crumb">{crumb}</span>
        <span className="page-keys">
          <kbd>L</kbd> legend
          {table ? (
            <>
              {' '}
              · <kbd>T</kbd> table
            </>
          ) : null}{' '}
          · <kbd>Esc</kbd> garden
        </span>
      </nav>
      <div className="page-body">{children}</div>
    </div>
  );
}

export function LoadingPage({ crumb }: { crumb: string }) {
  return (
    <PageShell crumb={crumb}>
      <p className="loading" role="status">
        Loading…
      </p>
    </PageShell>
  );
}
