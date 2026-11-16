/**
 * Charts Copilot draws with the show_visual tool: a Vega-Lite spec with inline data, drawn in the app's theme.
 * vega-embed is loaded on first use, so the tab stays light until a chart is needed.
 */
type Json = unknown;

/** Drops every key that could load data or open a link elsewhere: a chart may only draw the values it carries. */
function inlineOnly(value: Json): Json {
  if (Array.isArray(value)) return value.map(inlineOnly);
  if (value && typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, Json>)) {
      if (k === 'url' || k === 'href' || k === 'usermeta') continue;
      out[k] = inlineOnly(v);
    }
    return out;
  }
  return value;
}

function css(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function theme() {
  const text = css('--text', '#1c1b19');
  const muted = css('--muted', '#6b675f');
  const border = css('--border', '#e3dfd6');
  const accent = css('--accent', '#f26419');
  const font = css('--font', 'Fira Sans, sans-serif');
  return {
    background: 'transparent',
    font,
    view: { stroke: null },
    mark: { color: accent },
    bar: { color: accent, cornerRadiusEnd: 1 },
    line: { color: accent, strokeWidth: 2 },
    point: { color: accent, filled: true },
    range: { category: [accent, text, '#8a8478', '#c79a6b', '#55666e', '#b7b1a6'] },
    axis: {
      labelColor: muted, titleColor: muted, gridColor: border, domainColor: border, tickColor: border,
      labelFont: font, titleFont: font, titleFontWeight: 400, labelFontSize: 11, titleFontSize: 11.5,
    },
    legend: { labelColor: muted, titleColor: muted, labelFont: font, titleFont: font, titleFontWeight: 400 },
    title: { color: text, font, fontWeight: 500, anchor: 'start' },
  };
}

/** Faceted, repeated and concatenated views can't use width "container"; they keep their own cell sizes. */
function compound(spec: Record<string, Json>): boolean {
  const enc = (spec.encoding ?? {}) as Record<string, Json>;
  return ['facet', 'repeat', 'concat', 'hconcat', 'vconcat'].some((k) => k in spec) || 'row' in enc || 'column' in enc || 'facet' in enc;
}

/** Draws a spec into the element; throws with Vega's message when the spec can't be drawn. */
export async function drawVisual(el: HTMLElement, spec: Record<string, Json>): Promise<void> {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('spec must be a Vega-Lite object');
  const { default: embed } = await import('vega-embed');
  const clean = inlineOnly(spec) as Record<string, Json>;
  delete clean.$schema;
  const config = { ...theme(), ...((clean.config as Record<string, Json>) ?? {}) };
  let sized: Record<string, Json>;
  if (!compound(clean)) {
    sized = { ...clean, width: 'container', autosize: { type: 'fit-x', contains: 'padding' } };
  } else {
    sized = { ...clean };
    // Charts split into rows only get cells as wide as the box (less room for row labels and a legend).
    const enc = (clean.encoding ?? {}) as Record<string, Json>;
    const facet = (clean.facet ?? {}) as Record<string, Json>;
    const cell = Math.max(160, el.clientWidth - 200);
    if ('row' in enc && !('column' in enc) && sized.width === undefined) sized.width = cell;
    else if ('row' in facet && !('column' in facet) && clean.spec && typeof clean.spec === 'object' && (clean.spec as Record<string, Json>).width === undefined)
      sized.spec = { ...(clean.spec as Record<string, Json>), width: cell };
  }
  await embed(el, { ...sized, config } as never, { mode: 'vega-lite', actions: false, renderer: 'svg' });
}
