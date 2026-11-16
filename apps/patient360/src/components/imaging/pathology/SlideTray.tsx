/** One slide in the filmstrip: a slide of the patient's, or another slide of the TCGA case a slide comes from. */
export type TrayItem = {
  key: string;
  label: string;
  /** A short second line: preparation, normal tissue, AI layers. */
  detail: string;
  /** Hover text: barcode, preparation, composition, AI layers. */
  tip: string;
  thumbnail: string | null;
};

/** Filmstrip of every slide from the patient, under the viewer. Click to view; ⇆ shows it beside the current one. */
export function SlideTray({
  items,
  current,
  compare,
  onSelect,
  onCompare,
  onHide,
}: {
  items: TrayItem[];
  current: string;
  compare: string | null;
  onSelect: (key: string) => void;
  onCompare: ((key: string) => void) | null;
  onHide: () => void;
}) {
  return (
    <div className="slide-tray hair flex shrink-0 items-stretch gap-3 border-t px-4 py-2">
      <div className="flex w-[92px] shrink-0 flex-col justify-center text-[11.5px] leading-tight">
        <span className="font-medium" style={{ color: 'var(--ink)' }}>
          Slides from this patient
        </span>
        <span className="t-faint mt-0.5">{items.length === 1 ? '1 slide' : `${items.length} slides`}</span>
        <button type="button" className="link t-faint mt-1 self-start" onClick={onHide} title="Hide the filmstrip (turn it back on in Details › Controls)">
          hide
        </button>
      </div>
      <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-0.5">
        {items.map((img) => (
          <div key={img.key} className="tray-item" aria-current={img.key === current} data-compare={img.key === compare || undefined}>
            <button type="button" className="flex items-center gap-2 text-left" onClick={() => onSelect(img.key)} title={img.tip}>
              {img.thumbnail ? <img src={img.thumbnail} alt="" className="tray-thumb" loading="lazy" /> : <span className="tray-thumb" />}
              <span className="min-w-0">
                <span className="block max-w-[170px] truncate text-[12px] font-medium">{img.label}</span>
                <span className="t-faint block text-[11px]">
                  {img.detail}
                  {img.key === compare ? ' · right' : ''}
                </span>
              </span>
            </button>
            {onCompare && (
              <button type="button" className="tray-compare" onClick={() => onCompare(img.key)} title="Show beside the current slide" aria-label={`Compare with ${img.label}`}>
                ⇆
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
