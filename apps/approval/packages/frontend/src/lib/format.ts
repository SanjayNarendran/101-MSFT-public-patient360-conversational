/** Shared wording for the i2b2 query and the request record (the local discovery app uses the same rules). */

export type Value = { value_operator: string; value_constraint: string; value_type?: string; value_unit_of_measure?: string };
export type Item = {
  item_key: string;
  item_name?: string;
  constrain_by_value?: Value;
  constrain_by_modifier?: { modifier_key: string; modifier_name?: string; constrain_by_value?: Value };
  constrain_by_date?: { date_from?: string | null; date_to?: string | null };
};
export type Panel = {
  items: Item[];
  invert?: number;
  panel_timing?: string;
  total_item_occurrences?: number;
  panel_date_from?: string | null;
  panel_date_to?: string | null;
};
export type QueryDefinition = { query_name?: string; query_timing?: string; panels: Panel[] };

const OPS: Record<string, string> = { GT: '>', GE: '≥', LT: '<', LE: '≤', EQ: '=', NE: '≠' };
const TEXT_OPS: Record<string, string> = {
  EQ: 'is', NE: 'is not', IN: 'is one of', 'LIKE[contains]': 'contains', 'LIKE[begin]': 'starts with',
  'LIKE[end]': 'ends with', 'LIKE[exact]': 'is exactly',
};

export function valueText(v: Value): string {
  const unit = v.value_unit_of_measure ? ` ${v.value_unit_of_measure}` : '';
  if (v.value_type === 'TEXT') return `${TEXT_OPS[v.value_operator] ?? v.value_operator} ${v.value_constraint}`;
  if (v.value_operator === 'BETWEEN') return `between ${v.value_constraint.replace(/\s+and\s+/i, ' and ')}${unit}`;
  return `${OPS[v.value_operator] ?? v.value_operator} ${v.value_constraint}${unit}`;
}

export function dateText(from?: string | null, to?: string | null): string | null {
  if (from && to) return `${from} to ${to}`;
  if (from) return `from ${from}`;
  if (to) return `until ${to}`;
  return null;
}

/** Item name without the ontology path, e.g. "E11 Type 2 diabetes mellitus". */
export function itemName(item: Item): string {
  return item.item_name || item.item_key.replace(/\\+$/, '').split('\\').pop() || item.item_key;
}

export function itemConstraints(item: Item): string[] {
  const out: string[] = [];
  if (item.constrain_by_value) out.push(valueText(item.constrain_by_value));
  const m = item.constrain_by_modifier;
  if (m) {
    const name = m.modifier_name || m.modifier_key.replace(/\\+$/, '').split('\\').pop();
    out.push(m.constrain_by_value ? `${name} ${valueText(m.constrain_by_value)}` : String(name));
  }
  const d = item.constrain_by_date && dateText(item.constrain_by_date.date_from, item.constrain_by_date.date_to);
  if (d) out.push(d);
  return out;
}

export function panelTags(panel: Panel, queryTiming?: string): string[] {
  const tags: string[] = [];
  if (panel.invert) tags.push('NOT');
  if ((panel.total_item_occurrences ?? 1) > 1) tags.push(`at least ${panel.total_item_occurrences} times`);
  if (queryTiming === 'SAMEVISIT' && panel.panel_timing === 'SAMEVISIT') tags.push('same visit');
  const d = dateText(panel.panel_date_from, panel.panel_date_to);
  if (d) tags.push(d);
  return tags;
}

/** "2026-11-05 07:28:16" (UTC from SQL) -> "5 Nov 2026, 07:28 UTC" */
export function when(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return String(value);
  const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return `${date}, ${time} UTC`;
}

/** The UTC time of day with seconds, for steps that follow each other quickly. */
export function clock(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T') + (String(value).endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' })} UTC`;
}

/** Delivery job states that mean the run is still going. */
export const RUNNING = ['NotStarted', 'InProgress'];
export const DEMO_LIMITS = '25 patients, 20 documents and 5 imaging studies';

export const STATUS_WORDS: Record<string, string> = {
  PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', DELIVERED: 'Delivered',
};

export const EVENT_WORDS: Record<string, string> = {
  SUBMITTED: 'Submitted', APPROVED: 'Approved', REJECTED: 'Rejected', DELIVERY_REQUESTED: 'Delivery started',
  DELIVERY_STARTED: 'Delivery notebook running', DELIVERY_PROGRESS: 'Delivery step', DELIVERED: 'Delivered',
};
