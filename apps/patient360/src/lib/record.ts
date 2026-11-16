import type { Mark, MarkKind } from '@/components/patient/Timeline';

/**
 * The record's tabs. Each tab shows one kind of thing from the patient's life, and its items are marks on the
 * vertical timeline: selecting a mark opens its tab, and stepping through a tab moves the timeline selection.
 * The order follows the timeline's columns, left to right.
 */
export type TabId =
  | 'summary'
  | 'visits'
  | 'measurements'
  | 'conditions'
  | 'medicines'
  | 'cancer'
  | 'treatment'
  | 'pathology'
  | 'radiology'
  | 'report'
  | 'documents'
  | 'tests'
  | 'genomics'
  | 'notes'
  | 'cohorts';

export type TabGroup = 'overview' | 'primary' | 'cancer' | 'diagnostics' | 'board';

export interface TabDef {
  id: TabId;
  label: string;
  group: TabGroup;
  kinds: MarkKind[];
  /** Name for one item, used in "visit 3 of 120", and for several. */
  noun: string;
  plural: string;
  /** Longer name, shown as a tooltip. */
  hint?: string;
}

export const TABS: TabDef[] = [
  { id: 'summary', label: 'Summary', group: 'overview', kinds: [], noun: '', plural: '' },
  { id: 'visits', label: 'Visits', group: 'primary', kinds: ['visit'], noun: 'visit', plural: 'visits' },
  { id: 'measurements', label: 'Measurements', group: 'primary', kinds: ['visit'], noun: 'visit with results', plural: 'visits with results' },
  { id: 'conditions', label: 'Conditions', group: 'primary', kinds: ['condition'], noun: 'condition', plural: 'conditions' },
  { id: 'medicines', label: 'Medications', hint: 'Medications and immunisations', group: 'primary', kinds: ['medication', 'vaccine'], noun: 'item', plural: 'medications and immunisations' },
  { id: 'cancer', label: 'Cancer course', group: 'cancer', kinds: ['diagnosis', 'spread', 'status', 'outcome'], noun: 'event', plural: 'events' },
  { id: 'treatment', label: 'Treatment', group: 'cancer', kinds: ['surgery', 'radiation', 'drug'], noun: 'treatment', plural: 'treatments' },
  { id: 'radiology', label: 'Radiology', group: 'diagnostics', kinds: ['scan'], noun: 'study', plural: 'studies' },
  { id: 'pathology', label: 'Pathology', group: 'diagnostics', kinds: ['slide'], noun: 'slide', plural: 'slides' },
  { id: 'documents', label: 'Documents', hint: 'Reports and notes, typed and scanned', group: 'diagnostics', kinds: ['document'], noun: 'document', plural: 'documents' },
  { id: 'report', label: 'Report', hint: 'Pathology report', group: 'diagnostics', kinds: ['report'], noun: 'report', plural: 'reports' },
  { id: 'tests', label: 'Tests', group: 'diagnostics', kinds: ['tests'], noun: 'test date', plural: 'test dates' },
  { id: 'genomics', label: 'Genomics', group: 'diagnostics', kinds: ['genome'], noun: 'profile', plural: 'profiles' },
  { id: 'notes', label: 'Tumour board', group: 'board', kinds: ['note'], noun: 'note', plural: 'notes' },
  { id: 'cohorts', label: 'Cohorts', hint: 'Approved data requests that include this patient', group: 'board', kinds: [], noun: 'request', plural: 'requests' },
];

/** Whether a tab has anything to show: tabs of marks need marks; Cohorts needs a request. */
export function tabShown(t: TabDef, counts: Partial<Record<TabId, number>>): boolean {
  if (t.id === 'cohorts') return (counts.cohorts ?? 0) > 0;
  return !t.kinds.length || t.id === 'notes' || (counts[t.id] ?? 0) > 0;
}

export const TAB_IDS = new Set<string>(TABS.map((t) => t.id));

export function tabDef(id: TabId): TabDef {
  return TABS.find((t) => t.id === id)!;
}

/** The tab's items in time order. */
export function itemsFor(tab: TabId, marks: Mark[], measuredVisits: Set<string>): Mark[] {
  const kinds = tabDef(tab).kinds;
  return marks
    .filter((m) => kinds.includes(m.kind) && (tab !== 'measurements' || measuredVisits.has(m.id)))
    .sort((a, z) => a.start.getTime() - z.start.getTime() || a.row - z.row);
}

/** The tab a mark opens: the current tab when it can show the mark, otherwise the mark's own tab. */
export function tabFor(mark: Mark, current: TabId, measuredVisits: Set<string>): TabId {
  const cur = tabDef(current);
  if (cur.kinds.includes(mark.kind) && (current !== 'measurements' || measuredVisits.has(mark.id))) return current;
  return TABS.find((t) => t.id !== 'measurements' && t.kinds.includes(mark.kind))?.id ?? 'summary';
}
