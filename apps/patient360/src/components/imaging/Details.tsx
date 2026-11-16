import { useCallback, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export function PanelSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="hair border-t px-5 py-5 first:border-t-0">
      <div className="t-label mb-3 flex items-baseline justify-between gap-3">
        <span>{title}</span>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function PanelRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-3 py-1 text-[12.5px]">
      <dt className="t-faint">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** A setting remembered across slides, studies and visits. */
export function useStoredState<T extends string>(key: string, initial: () => T, allowed: readonly T[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key) as T | null;
    return stored && allowed.includes(stored) ? stored : initial();
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      localStorage.setItem(key, v);
    },
    [key]
  );
  return [value, set];
}

/** A collapsed side panel: a slim rail that opens it again. */
function Rail({ side, label, onOpen }: { side: 'left' | 'right'; label: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`rail hair shrink-0 ${side === 'left' ? 'border-r' : 'border-l'}`}
      onClick={onOpen}
      title={`Show ${label.toLowerCase()}`}
      aria-label={`Show ${label.toLowerCase()}`}
      aria-expanded={false}
    >
      <span aria-hidden className="rail-chevron">
        {side === 'left' ? '›' : '‹'}
      </span>
      <span className="rail-label">{label}</span>
    </button>
  );
}

export type DetailsTab = 'about' | 'case' | 'bundles' | 'controls';
const DETAILS_TABS: { id: DetailsTab; label: string }[] = [
  { id: 'about', label: 'About' },
  { id: 'case', label: 'Case' },
  { id: 'bundles', label: 'Bundles' },
  { id: 'controls', label: 'Controls' },
];

/**
 * Open/closed state and active tab of the right-hand details panel, remembered across workspaces. `folded` starts
 * this one closed whatever was remembered (an image inside an answer keeps its width); opening it is remembered.
 */
export function useDetailsPanel(folded = false) {
  const [stored, setStored] = useStoredState<'open' | 'closed'>(
    'p360.imaging.details',
    () => (window.innerWidth >= 1500 ? 'open' : 'closed'),
    ['open', 'closed']
  );
  const [local, setLocal] = useState<'open' | 'closed' | null>(folded ? 'closed' : null);
  const state = local ?? stored;
  const setState = (v: 'open' | 'closed') => {
    setLocal(null);
    setStored(v);
  };
  const [tab, setTab] = useStoredState<DetailsTab>('p360.imaging.detailsTab', () => 'about', ['about', 'case', 'bundles', 'controls']);
  const scrollRef = useRef<HTMLDivElement>(null);
  const open = state === 'open';
  return {
    open,
    tab,
    setTab,
    scrollRef,
    setOpen: (o: boolean) => setState(o ? 'open' : 'closed'),
    /** Open the panel on a tab, scrolled to the top. */
    show: (t: DetailsTab) => {
      setState('open');
      setTab(t);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0 }));
    },
  };
}

export type DetailsPanelState = ReturnType<typeof useDetailsPanel>;

/**
 * The viewers' right-hand panel (from the imaging demo): About (what the image shows, its source and where it is
 * stored), Case (the TCGA case a slide comes from, where there is one), Bundles (a tractography atlas's) and Controls.
 * Collapses to a rail.
 */
export function DetailsPanel({
  panel,
  about,
  caseInfo,
  bundles,
  controls,
}: {
  panel: DetailsPanelState;
  about: ReactNode;
  caseInfo?: ReactNode;
  /** A tractography atlas's bundles. */
  bundles?: ReactNode;
  controls: ReactNode;
}) {
  if (!panel.open) return <Rail side="right" label="Details" onOpen={() => panel.setOpen(true)} />;
  const tabs = DETAILS_TABS.filter((t) => (t.id !== 'case' || caseInfo) && (t.id !== 'bundles' || bundles));
  const active = tabs.some((t) => t.id === panel.tab) ? panel.tab : 'about';
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = tabs.findIndex((t) => t.id === active);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    panel.setTab(next.id);
    document.getElementById(`details-tab-${next.id}`)?.focus();
  };
  return (
    <aside className="hair flex w-[330px] shrink-0 flex-col border-l" aria-label="Details">
      <div className="hair flex h-11 shrink-0 items-stretch gap-5 border-b pl-5 pr-3" role="tablist" aria-label="Details" onKeyDown={onKey}>
        {tabs.map((t) => (
          <button
            key={t.id}
            id={`details-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            aria-controls="details-tabpanel"
            tabIndex={active === t.id ? 0 : -1}
            className={`tab ${active === t.id ? 'active' : ''}`}
            onClick={() => panel.setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          className="icon-btn ml-auto self-center"
          onClick={() => panel.setOpen(false)}
          title="Hide details"
          aria-label="Hide details"
          aria-expanded
        >
          ›
        </button>
      </div>
      <div
        ref={panel.scrollRef}
        id="details-tabpanel"
        role="tabpanel"
        aria-labelledby={`details-tab-${active}`}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {active === 'about' ? about : active === 'case' ? caseInfo : active === 'bundles' ? bundles : controls}
      </div>
    </aside>
  );
}
