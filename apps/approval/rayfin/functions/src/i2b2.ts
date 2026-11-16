/*
 * i2b2 query definitions for the Discovery tab: the model, the i2b2 XML, the DAX compiler, the plain-language summary
 * and the CRC obfuscation. A port of scripts/i2b2_query.py and scripts/i2b2_crc.py, which the local app and the MCP
 * server use; keep the two in step (scripts/23_discovery_chat.py check compares their DAX on the stored queries).
 *
 * A query definition follows the i2b2 CRC request format: items inside a panel are OR-ed, panels are AND-ed, an
 * inverted panel is a NOT; query_timing ANY (patient level) or SAMEVISIT (the same encounter). Compilation is driven
 * by the ontology metadata, as in the i2b2 CRC.
 */
import { randomInt } from 'node:crypto';

export const NUMERIC_OPS: Record<string, string> = { GT: '>', GE: '>=', LT: '<', LE: '<=', EQ: '=', NE: '<>' };
const TEXT_OPS = ['EQ', 'NE', 'IN', 'LIKE[contains]', 'LIKE[begin]', 'LIKE[end]', 'LIKE[exact]'];
const TIMINGS = ['ANY', 'SAMEVISIT'];
const FACT = 'observation_fact';
const PATIENT = 'patient_dimension';
const VISIT = 'visit_dimension';
const CONCEPT = 'concept_dimension';
const MODIFIER = 'modifier_dimension';
const BS = '\\';

type Dict = Record<string, unknown>;

/** Python's str(float): 6 -> "6.0", 6.5 -> "6.5" (keeps the DAX identical to the Python compiler's). */
function pyFloat(x: number): string {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

function toFloat(s: string): number {
  const n = Number(String(s).trim());
  if (String(s).trim() === '' || Number.isNaN(n)) throw new Error(`could not convert string to float: '${s}'`);
  return n;
}

/** Length in code points, as Python's len(). */
const len = (s: string) => Array.from(s).length;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const splitAnd = (s: string) => s.trim().split(/\s+and\s+/i);

/* ------------------------------------------------------------------ query definition */

export class ValueConstraint {
  constructor(
    public operator: string,
    public value: string,
    public valueType = 'NUMBER',
    public unit: string | null = null
  ) {}

  static fromDict(d: Dict | null | undefined): ValueConstraint | null {
    if (!d || Object.keys(d).length === 0) return null;
    let op = str(d.value_operator ?? d.operator).toUpperCase();
    const like = op.match(/^LIKE\[(.*)\]$/);
    if (like) op = `LIKE[${like[1].toLowerCase()}]`;
    const v = new ValueConstraint(
      op,
      str(d.value_constraint ?? d.value),
      str(d.value_type ?? 'NUMBER').toUpperCase(),
      (d.value_unit_of_measure ?? d.unit ?? null) as string | null
    );
    if (v.valueType === 'NUMBER' && !(op in NUMERIC_OPS) && op !== 'BETWEEN') throw new Error(`Unsupported numeric operator ${op}`);
    if (v.valueType === 'TEXT' && !TEXT_OPS.includes(op)) throw new Error(`Unsupported text operator ${op}`);
    return v;
  }

  numbers(): number[] {
    return (this.operator === 'BETWEEN' ? splitAnd(this.value) : [this.value]).map(toFloat);
  }

  texts(): string[] {
    return this.operator === 'IN' ? this.value.split(',').map((t) => t.trim().replace(/^['"]+|['"]+$/g, '')) : [this.value];
  }

  toDict(): Dict {
    return {
      value_operator: this.operator, value_constraint: this.value, value_type: this.valueType,
      ...(this.unit ? { value_unit_of_measure: this.unit } : {}),
    };
  }
}

export class ModifierConstraint {
  constructor(
    public modifierKey: string,
    public modifierName = '',
    public appliedPath = '',
    public value: ValueConstraint | null = null
  ) {}

  static fromDict(d: Dict | null | undefined): ModifierConstraint | null {
    if (!d || Object.keys(d).length === 0) return null;
    if (!d.modifier_key) throw new Error("A modifier constraint needs a modifier_key");
    return new ModifierConstraint(str(d.modifier_key), str(d.modifier_name), str(d.applied_path),
      ValueConstraint.fromDict(d.constrain_by_value as Dict));
  }
}

export class Item {
  constructor(
    public itemKey: string,
    public itemName = '',
    public value: ValueConstraint | null = null,
    public modifier: ModifierConstraint | null = null,
    public dateFrom: string | null = null,
    public dateTo: string | null = null
  ) {}

  static fromDict(d: Dict): Item {
    if (!d || !d.item_key) throw new Error('Every item needs an item_key from the ontology tools');
    const date = (d.constrain_by_date as Dict) || {};
    return new Item(str(d.item_key), str(d.item_name), ValueConstraint.fromDict(d.constrain_by_value as Dict),
      ModifierConstraint.fromDict(d.constrain_by_modifier as Dict), (date.date_from as string) || null, (date.date_to as string) || null);
  }
}

export class Panel {
  constructor(
    public items: Item[],
    public invert = false,
    public timing = 'ANY',
    public occurrences = 1,
    public dateFrom: string | null = null,
    public dateTo: string | null = null
  ) {}

  static fromDict(d: Dict, defaultTiming = 'ANY'): Panel {
    const items = (d.items as Dict[]) ?? [];
    const p = new Panel(items.map((i) => Item.fromDict(i)), Boolean(Number(d.invert ?? 0)),
      str(d.panel_timing || defaultTiming).toUpperCase(), Math.trunc(Number(d.total_item_occurrences ?? 1)) || 1,
      (d.panel_date_from as string) || null, (d.panel_date_to as string) || null);
    if (!p.items.length) throw new Error('A panel needs at least one item');
    if (!TIMINGS.includes(p.timing)) throw new Error(`Unsupported panel_timing ${p.timing}`);
    return p;
  }
}

export class QueryDefinition {
  constructor(
    public panels: Panel[],
    public name = '',
    public timing = 'ANY',
    public specificityScale = 0
  ) {}

  static fromDict(d: Dict): QueryDefinition {
    if (!d || typeof d !== 'object') throw new Error('Give a query definition with panels');
    const timing = str(d.query_timing || 'ANY').toUpperCase();
    const q = new QueryDefinition(((d.panels as Dict[]) ?? []).map((p) => Panel.fromDict(p, timing)), str(d.query_name),
      timing, Math.trunc(Number(d.specificity_scale ?? 0)) || 0);
    if (!q.panels.length) throw new Error('A query needs at least one panel');
    if (!TIMINGS.includes(q.timing)) throw new Error(`Unsupported query_timing ${q.timing}`);
    return q;
  }

  /** A panel is joined on the encounter only when both the query and the panel are SAMEVISIT (as in i2b2). */
  panelTiming(p: Panel): string {
    return this.timing === 'SAMEVISIT' && p.timing === 'SAMEVISIT' ? 'SAMEVISIT' : 'ANY';
  }

  toDict(): Dict {
    const item = (i: Item): Dict => {
      const out: Dict = { item_key: i.itemKey, item_name: i.itemName };
      if (i.value) out.constrain_by_value = i.value.toDict();
      if (i.modifier) {
        out.constrain_by_modifier = {
          modifier_key: i.modifier.modifierKey, modifier_name: i.modifier.modifierName, applied_path: i.modifier.appliedPath,
          ...(i.modifier.value ? { constrain_by_value: i.modifier.value.toDict() } : {}),
        };
      }
      if (i.dateFrom || i.dateTo) out.constrain_by_date = { date_from: i.dateFrom, date_to: i.dateTo };
      return out;
    };
    return {
      query_name: this.name, query_timing: this.timing, specificity_scale: this.specificityScale,
      panels: this.panels.map((p, n) => ({
        panel_number: n + 1, invert: p.invert ? 1 : 0, panel_timing: p.timing, total_item_occurrences: p.occurrences,
        panel_date_from: p.dateFrom, panel_date_to: p.dateTo, items: p.items.map(item),
      })),
    };
  }

  /** As the i2b2 web client names queries: each panel's first item cut to 15 / panels characters, then @HH:MM:SS. */
  autoName(at = new Date()): string {
    const size = Math.max(1, Math.floor(15 / this.panels.length));
    const parts = this.panels.map((p) => Array.from(p.items[0].itemName || lastPart(p.items[0].itemKey)).slice(0, size).join(''));
    return parts.join('-') + '@' + at.toISOString().slice(11, 19);
  }

  /** Checks every item against the ontology and fills canonical item keys and names (in place). */
  normalize(ontology: Ontology): this {
    for (const p of this.panels) {
      for (const i of p.items) {
        const node = ontology.node(i.itemKey);
        i.itemKey = ontology.key(node.fullname);
        i.itemName = i.itemName || node.name;
        if (i.modifier) {
          const m = ontology.node(i.modifier.modifierKey);
          i.modifier.modifierKey = ontology.key(m.fullname);
          i.modifier.modifierName = i.modifier.modifierName || m.name;
          i.modifier.appliedPath = i.modifier.appliedPath || node.fullname + '%';
        }
      }
    }
    if (!this.name) this.name = this.autoName();
    return this;
  }
}

function lastPart(key: string): string {
  const parts = key.replace(/\\+$/, '').split(BS);
  return parts[parts.length - 1];
}

/* ------------------------------------------------------------------ ontology */

export type Node = {
  fullname: string;
  name: string;
  tablename: string;
  columnname: string;
  operator: string;
  dimcode: string;
  datatype: string;
  facttablecolumn: string;
  basecode: string | null;
  visual: string;
  hlevel: number;
  totalnum: number | null;
  metadataxml: string | null;
  appliedPath: string | null;
};

const count = (s: string, ch: string) => s.split(ch).length - 1;
const byName = (a: Node, b: Node) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export class Ontology {
  constructor(public nodes: Map<string, Node>, public tables: Map<string, string>) {}

  static fromRows(ontology: Dict[], tableAccess: Dict[]): Ontology {
    const nodes = new Map<string, Node>();
    for (const r of ontology) {
      nodes.set(str(r.c_fullname), {
        fullname: str(r.c_fullname), name: str(r.c_name), tablename: str(r.c_tablename).toLowerCase(),
        columnname: str(r.c_columnname).toLowerCase(), operator: str(r.c_operator).toUpperCase(), dimcode: str(r.c_dimcode),
        datatype: str(r.c_columndatatype), facttablecolumn: str(r.c_facttablecolumn).toLowerCase(),
        basecode: (r.c_basecode as string) ?? null, visual: str(r.c_visualattributes), hlevel: Math.trunc(Number(r.c_hlevel)),
        totalnum: r.c_totalnum === null || r.c_totalnum === undefined ? null : Number(r.c_totalnum),
        metadataxml: (r.c_metadataxml as string) ?? null, appliedPath: (r.m_applied_path as string) ?? null,
      });
    }
    return new Ontology(nodes, new Map(tableAccess.map((r) => [str(r.c_table_cd), str(r.c_fullname)])));
  }

  /** item_key (\\TABLE_CD\path\) for an ontology path. */
  key(fullname: string): string {
    let table: string | null = null;
    let best = -1;
    for (const [cd, root] of this.tables) {
      if (fullname.startsWith(root) && root.length > best) { table = cd; best = root.length; }
    }
    if (table === null && fullname.startsWith(BS) && !fullname.startsWith('\\i2b2\\')) table = 'i2b2_modifiers';
    return `${BS}${BS}${table ?? 'None'}${fullname}`;
  }

  /** Accepts \\TABLE_CD\path\ or a bare path. */
  node(itemKey: string): Node {
    let path = String(itemKey ?? '');
    const m = path.match(/^\\\\[^\\]+(\\.*)$/s);
    if (m) path = m[1];
    if (!path.endsWith(BS)) path += BS;
    const node = this.nodes.get(path);
    if (!node) throw new Error(`Unknown ontology item '${itemKey}'`);
    return node;
  }

  /** A bare path for an item_key or path (used for "under"). */
  path(keyOrPath: string): string {
    const m = keyOrPath.match(/^\\\\[^\\]+(\\.*)$/s);
    return m ? m[1] : keyOrPath;
  }

  children(fullname: string): Node[] {
    const level = count(fullname, BS);
    return [...this.nodes.values()].filter((n) => n.fullname.startsWith(fullname) && count(n.fullname, BS) === level + 1).sort(byName);
  }

  search(text: string, limit = 25, under: string | null = null): Node[] {
    const words = text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    const root = under ? this.path(under) : null;
    const hits = [...this.nodes.values()].filter((n) => (!root || n.fullname.startsWith(root))
      && words.every((w) => (n.name + ' ' + (n.basecode ?? '')).toLowerCase().includes(w)));
    return hits.sort((a, b) => (b.totalnum ?? 0) - (a.totalnum ?? 0) || a.hlevel - b.hlevel).slice(0, limit);
  }
}

/* ------------------------------------------------------------------ XML (the i2b2 request message body) */

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function toXml(q: QueryDefinition, ontology: Ontology | null = null): string {
  const tag = (name: string, value: unknown, indent: number) =>
    value === null || value === undefined || value === '' ? '' : `${' '.repeat(indent)}<${name}>${escapeXml(String(value))}</${name}>\n`;
  const valueXml = (v: ValueConstraint, indent: number, name = 'constrain_by_value') => {
    const pad = ' '.repeat(indent);
    return `${pad}<${name}>\n` + tag('value_operator', v.operator, indent + 2) + tag('value_constraint', v.value, indent + 2)
      + tag('value_unit_of_measure', v.unit, indent + 2) + tag('value_type', v.valueType, indent + 2) + `${pad}</${name}>\n`;
  };
  const out = ['<query_definition>\n', tag('query_name', q.name, 2), tag('query_timing', q.timing, 2),
    tag('specificity_scale', q.specificityScale, 2)];
  q.panels.forEach((p, idx) => {
    out.push('  <panel>\n', tag('panel_number', idx + 1, 4), tag('panel_date_from', p.dateFrom, 4), tag('panel_date_to', p.dateTo, 4),
      tag('panel_accuracy_scale', 100, 4), tag('invert', p.invert ? 1 : 0, 4), tag('panel_timing', p.timing, 4),
      tag('total_item_occurrences', p.occurrences, 4));
    for (const i of p.items) {
      const node = ontology ? ontology.node(i.itemKey) : null;
      out.push('    <item>\n', tag('hlevel', node ? node.hlevel : '', 6), tag('item_name', i.itemName || (node ? node.name : ''), 6),
        tag('item_key', i.itemKey.startsWith(BS + BS) || !ontology ? i.itemKey : ontology.key(node!.fullname), 6),
        tag('tooltip', node ? node.name : '', 6), tag('class', 'ENC', 6), tag('item_icon', node ? node.visual.trim() : '', 6),
        tag('item_is_synonym', 'false', 6));
      if (i.value) out.push(valueXml(i.value, 6));
      if (i.dateFrom || i.dateTo) {
        out.push('      <constrain_by_date>\n', tag('date_from', i.dateFrom, 8), tag('date_to', i.dateTo, 8), '      </constrain_by_date>\n');
      }
      if (i.modifier) {
        const m = i.modifier;
        out.push('      <constrain_by_modifier>\n', tag('modifier_name', m.modifierName, 8), tag('applied_path', m.appliedPath, 8),
          tag('modifier_key', m.modifierKey, 8));
        if (m.value) out.push(valueXml(m.value, 8));
        out.push('      </constrain_by_modifier>\n');
      }
      out.push('    </item>\n');
    }
    out.push('  </panel>\n');
  });
  out.push('</query_definition>\n');
  return out.join('');
}

/* ------------------------------------------------------------------ DAX compiler */

const daxStr = (s: string) => '"' + s.replace(/"/g, '""') + '"';
function daxDate(d: string): string {
  const [y, m, day] = d.slice(0, 10).split('-').map((x) => Number.parseInt(x, 10));
  if ([y, m, day].some((x) => Number.isNaN(x))) throw new Error(`invalid literal for int() with base 10: '${d}'`);
  return `DATE(${y}, ${m}, ${day})`;
}
const col = (table: string, column: string) => `'${table}'[${column}]`;

/** Builds DAX table expressions; every one returns [patient_num] (and [encounter_num] at visit level). */
export class DaxCompiler {
  constructor(private ontology: Ontology) {}

  private codes(node: Node): string {
    const path = node.operator === 'LIKE' ? node.dimcode : node.fullname;
    return `SELECTCOLUMNS(FILTER(ALL(${col(CONCEPT, 'concept_path')}, ${col(CONCEPT, 'concept_cd')}), `
      + `LEFT(${col(CONCEPT, 'concept_path')}, ${len(path)}) = ${daxStr(path)}), "concept_cd", ${col(CONCEPT, 'concept_cd')})`;
  }

  private modifierCodes(m: ModifierConstraint): string {
    const node = this.ontology.node(m.modifierKey);
    return `SELECTCOLUMNS(FILTER(ALL(${col(MODIFIER, 'modifier_path')}, ${col(MODIFIER, 'modifier_cd')}), `
      + `LEFT(${col(MODIFIER, 'modifier_path')}, ${len(node.fullname)}) = ${daxStr(node.fullname)}), "modifier_cd", ${col(MODIFIER, 'modifier_cd')})`;
  }

  private static valueFilters(v: ValueConstraint | null): string[] {
    if (!v) return [];
    if (v.valueType === 'NUMBER') {
      const nv = col(FACT, 'nval_num');
      if (v.operator === 'BETWEEN') {
        const [lo, hi] = v.numbers();
        return [`${col(FACT, 'valtype_cd')} = "N"`, `KEEPFILTERS(${nv} >= ${pyFloat(lo)} && ${nv} <= ${pyFloat(hi)})`];
      }
      return [`${col(FACT, 'valtype_cd')} = "N"`, `${nv} ${NUMERIC_OPS[v.operator]} ${pyFloat(v.numbers()[0])}`];
    }
    const tv = col(FACT, 'tval_char');
    if (v.operator === 'IN') return [`${tv} IN {${v.texts().map(daxStr).join(', ')}}`];
    if (v.operator.startsWith('LIKE')) {
      const kind = v.operator.slice(5, -1);
      const text = daxStr(v.value);
      return [({
        contains: `KEEPFILTERS(CONTAINSSTRING(${tv}, ${text}))`,
        begin: `KEEPFILTERS(LEFT(${tv}, ${len(v.value)}) = ${text})`,
        end: `KEEPFILTERS(RIGHT(${tv}, ${len(v.value)}) = ${text})`,
        exact: `${tv} = ${text}`,
      } as Record<string, string>)[kind]];
    }
    return [`${tv} ${NUMERIC_OPS[v.operator]} ${daxStr(v.value)}`];
  }

  private static dateFilters(from: string | null, to: string | null): string[] {
    const out: string[] = [];
    if (from) out.push(`${col(FACT, 'start_date')} >= ${daxDate(from)}`);
    if (to) out.push(`${col(FACT, 'start_date')} < ${daxDate(to)} + 1`);
    return out;
  }

  private factSet(filters: string[], visit: boolean, counted: boolean): string {
    const cols = [`"patient_num", ${col(FACT, 'patient_num')}`];
    const group = [col(FACT, 'patient_num')];
    if (visit) {
      cols.push(`"encounter_num", ${col(FACT, 'encounter_num')}`);
      group.push(col(FACT, 'encounter_num'));
    }
    let body = `SUMMARIZE('${FACT}', ${group.join(', ')})`;
    if (counted) {
      body = `ADDCOLUMNS(${body}, "n", CALCULATE(COUNTROWS('${FACT}')))`;
      cols.push('"n", [n]');
    }
    return `SELECTCOLUMNS(CALCULATETABLE(${body}, ${filters.join(', ')}), ${cols.join(', ')})`;
  }

  item(item: Item, panel: Panel, visit: boolean, counted = false): string {
    const node = this.ontology.node(item.itemKey);
    const dates = DaxCompiler.dateFilters(item.dateFrom || panel.dateFrom, item.dateTo || panel.dateTo);
    if (node.tablename === CONCEPT) {
      const base = [`TREATAS(${this.codes(node)}, ${col(FACT, 'concept_cd')})`, ...dates];
      if (item.modifier) {
        const key = ['patient_num', 'encounter_num', 'provider_id', 'start_date', 'instance_num'];
        const tuples = (flt: string[]) => `CALCULATETABLE(SUMMARIZE('${FACT}', ${key.map((k) => col(FACT, k)).join(', ')}), ${flt.join(', ')})`;
        const facts = tuples([...base, `${col(FACT, 'modifier_cd')} = "@"`, ...DaxCompiler.valueFilters(item.value)]);
        const mods = tuples([...base, `TREATAS(${this.modifierCodes(item.modifier)}, ${col(FACT, 'modifier_cd')})`,
          ...DaxCompiler.valueFilters(item.modifier.value)]);
        const cols = ['"patient_num", [patient_num]', ...(visit ? ['"encounter_num", [encounter_num]'] : [])];
        if (counted) {
          return `GROUPBY(SELECTCOLUMNS(INTERSECT(${facts}, ${mods}), ${cols.join(', ')}), [patient_num]`
            + `${visit ? ', [encounter_num]' : ''}, "n", COUNTX(CURRENTGROUP(), 1))`;
        }
        return `DISTINCT(SELECTCOLUMNS(INTERSECT(${facts}, ${mods}), ${cols.join(', ')}))`;
      }
      return this.factSet([...base, `${col(FACT, 'modifier_cd')} = "@"`, ...DaxCompiler.valueFilters(item.value)], visit, counted);
    }
    if (item.value || item.modifier) throw new Error(`${node.name}: value and modifier constraints apply to concept items only`);
    if (node.tablename === PATIENT) {
      const patients = DaxCompiler.dimensionSet(PATIENT, node, ['patient_num']);
      if (!visit) return DaxCompiler.withCount(patients, counted);
      return DaxCompiler.withCount(
        `SELECTCOLUMNS(CALCULATETABLE(SUMMARIZE('${VISIT}', ${col(VISIT, 'patient_num')}, ${col(VISIT, 'encounter_num')}), `
        + `TREATAS(${patients}, ${col(VISIT, 'patient_num')})), "patient_num", ${col(VISIT, 'patient_num')}, "encounter_num", `
        + `${col(VISIT, 'encounter_num')})`, counted);
    }
    if (node.tablename === VISIT) {
      if (counted && !visit) {
        const pairs = DaxCompiler.dimensionSet(VISIT, node, ['patient_num', 'encounter_num']);
        return `GROUPBY(${pairs}, [patient_num], "n", COUNTX(CURRENTGROUP(), 1))`;
      }
      return DaxCompiler.withCount(DaxCompiler.dimensionSet(VISIT, node, visit ? ['patient_num', 'encounter_num'] : ['patient_num']), counted);
    }
    throw new Error(`${node.name}: unsupported ontology table ${node.tablename}`);
  }

  private static withCount(expr: string, counted: boolean): string {
    return counted ? `ADDCOLUMNS(${expr}, "n", 1)` : expr;
  }

  private static dimensionSet(table: string, node: Node, keys: string[]): string {
    const column = col(table, node.columnname);
    let condition: string | null;
    if (node.operator === 'IN') condition = null;
    else if (node.operator === 'BETWEEN') {
      const [lo, hi] = splitAnd(node.dimcode).map(toFloat);
      condition = `KEEPFILTERS(${column} >= ${pyFloat(lo)} && ${column} <= ${pyFloat(hi)})`;
    } else if (node.operator === '=') {
      condition = `${column} = ${node.datatype === 'N' ? node.dimcode : daxStr(node.dimcode)}`;
    } else if (node.operator === 'LIKE') {
      condition = `KEEPFILTERS(LEFT(${column}, ${len(node.dimcode)}) = ${daxStr(node.dimcode)})`;
    } else throw new Error(`Unsupported operator ${node.operator} on ${node.fullname}`);
    // A whole dimension includes the blank member Direct Lake adds for unmatched fact keys; leave it out
    condition = condition ?? `NOT ISBLANK(${col(table, keys[0])})`;
    const body = `CALCULATETABLE(SUMMARIZE('${table}', ${keys.map((k) => col(table, k)).join(', ')}), ${condition})`;
    return `SELECTCOLUMNS(${body}, ${keys.map((k) => `"${k}", ${col(table, k)}`).join(', ')})`;
  }

  panel(panel: Panel, visit: boolean): string {
    if (panel.occurrences > 1) {
      const parts = panel.items.map((i) => this.item(i, panel, visit, true));
      const union = parts.length === 1 ? parts[0] : `UNION(${parts.join(', ')})`;
      const keys = visit ? '[patient_num], [encounter_num]' : '[patient_num]';
      const cols = '"patient_num", [patient_num]' + (visit ? ', "encounter_num", [encounter_num]' : '');
      return `SELECTCOLUMNS(FILTER(GROUPBY(${union}, ${keys}, "n", SUMX(CURRENTGROUP(), [n])), [n] >= ${panel.occurrences}), ${cols})`;
    }
    const parts = panel.items.map((i) => this.item(i, panel, visit));
    return parts.length === 1 ? parts[0] : `DISTINCT(UNION(${parts.join(', ')}))`;
  }

  /** [VAR definitions, the expression of the patient set with one column [patient_num]]. */
  cohort(q: QueryDefinition): [[string, string][], string] {
    const variables: [string, string][] = [];
    const groups: Record<string, [string[], string[]]> = { ANY: [[], []], SAMEVISIT: [[], []] };
    q.panels.forEach((p, idx) => {
      const timing = q.panelTiming(p);
      const name = `__panel${idx + 1}`;
      variables.push([name, this.panel(p, timing === 'SAMEVISIT')]);
      groups[timing][p.invert ? 1 : 0].push(name);
    });
    const sets: string[] = [];
    for (const [timing, [include, exclude]] of Object.entries(groups)) {
      if (!include.length && !exclude.length) continue;
      const visit = timing === 'SAMEVISIT';
      let expr: string;
      if (include.length) {
        expr = include[0];
        for (const other of include.slice(1)) expr = `INTERSECT(${expr}, ${other})`;
      } else {
        expr = visit
          ? `SELECTCOLUMNS(CALCULATETABLE(SUMMARIZE('${VISIT}', ${col(VISIT, 'patient_num')}, ${col(VISIT, 'encounter_num')}), `
            + `NOT ISBLANK(${col(VISIT, 'encounter_num')})), "patient_num", ${col(VISIT, 'patient_num')}, "encounter_num", `
            + `${col(VISIT, 'encounter_num')})`
          : `SELECTCOLUMNS(ALLNOBLANKROW(${col(PATIENT, 'patient_num')}), "patient_num", ${col(PATIENT, 'patient_num')})`;
      }
      for (const other of exclude) expr = `EXCEPT(${expr}, ${other})`;
      if (visit) expr = `DISTINCT(SELECTCOLUMNS(${expr}, "patient_num", [patient_num]))`;
      sets.push(expr);
    }
    return [variables, sets.length === 1 ? sets[0] : `INTERSECT(${sets[0]}, ${sets[1]})`];
  }

  /** One DAX query: the patient count plus a count per breakdown category (each category is an ontology node). */
  countQuery(q: QueryDefinition, breakdowns: [string, Node[]][]): string {
    const [variables, cohort] = this.cohort(q);
    const rows = ['ROW("result_type", "PATIENT_COUNT_XML", "category", "Patient count", "set_size", COUNTROWS(__cohort))'];
    for (const [resultType, nodes] of breakdowns) {
      for (const node of nodes) {
        const category = new Item(node.fullname);
        rows.push(`ROW("result_type", ${daxStr(resultType)}, "category", ${daxStr(node.name)}, "set_size", COUNTROWS(INTERSECT(__cohort, `
          + `${this.item(category, new Panel([category]), false)})))`);
      }
    }
    return ['DEFINE', ...variables.map(([n, e]) => `    VAR ${n} = ${e}`), `    VAR __cohort = ${cohort}`, 'EVALUATE',
      `UNION(${rows.join(', ')})`].join('\n');
  }

  patientSetQuery(q: QueryDefinition): string {
    const [variables, cohort] = this.cohort(q);
    return ['DEFINE', ...variables.map(([n, e]) => `    VAR ${n} = ${e}`), `    VAR __cohort = ${cohort}`, 'EVALUATE __cohort',
      'ORDER BY [patient_num]'].join('\n');
  }
}

/* ------------------------------------------------------------------ plain-language summary */

const SYMBOLS: Record<string, string> = { GT: '>', GE: '≥', LT: '<', LE: '≤', EQ: '=', NE: '≠' };

function constraintText(v: ValueConstraint): string {
  let text: string;
  if (v.operator === 'BETWEEN') {
    const [lo, hi] = v.value.split(/\s+and\s+/i);
    text = `between ${lo} and ${hi}`;
  } else if (v.operator.startsWith('LIKE')) text = `${v.operator.slice(5, -1)} '${v.value}'`;
  else if (v.operator === 'IN') text = 'in (' + v.texts().join(', ') + ')';
  else text = `${SYMBOLS[v.operator] ?? v.operator} ${v.value}`;
  return text + (v.unit ? ` ${v.unit}` : '');
}

/** The query in plain language, panel by panel (AND between panels, OR inside a panel). */
export function describe(q: QueryDefinition, ontology: Ontology): string {
  return q.panels.map((p, idx) => {
    const terms = p.items.map((i) => {
      const node = ontology.node(i.itemKey);
      const cut = node.fullname.lastIndexOf(BS, node.fullname.length - 2);
      const parent = ontology.nodes.get(node.fullname.slice(0, cut + 1));
      let name = node.name;
      if (node.basecode && node.basecode.includes('|') && parent) name = `${parent.name} = ${node.name}`;
      if (i.value) name += ` ${constraintText(i.value)}`;
      if (i.modifier) {
        const mod = ontology.node(i.modifier.modifierKey);
        name += ` (${mod.fullname.replace(/^\\+|\\+$/g, '').split(BS)[0]}: ${mod.name}`;
        name += i.modifier.value ? ` ${constraintText(i.modifier.value)})` : ')';
      }
      if (i.dateFrom || i.dateTo) name += ` [${i.dateFrom || '…'} to ${i.dateTo || '…'}]`;
      return name;
    });
    const extras: string[] = [];
    if (p.occurrences > 1) extras.push(`at least ${p.occurrences} times`);
    if (p.dateFrom || p.dateTo) extras.push(`dated ${p.dateFrom || '…'} to ${p.dateTo || '…'}`);
    if (q.panelTiming(p) === 'SAMEVISIT') extras.push('in the same encounter');
    const prefix = (idx === 0 ? '' : 'AND ') + (p.invert ? 'NOT ' : '');
    return `${prefix}Panel ${idx + 1}: ` + terms.join(' OR ') + (extras.length ? ` (${extras.join('; ')})` : '');
  }).join('\n');
}

/* ------------------------------------------------------------------ CRC: obfuscation and result messages */

export const PROJECT = 'COHORT_DEMO';
export const SIGMA_TOTAL = 1.323;
export const SIGMA_BREAKDOWN = 1.6;
const MINIMUM = 3;
const OBFUSCATED_DISPLAY = 3;

export const RESULT_TYPE_IDS: Record<string, number> = {
  PATIENTSET: 1, PATIENT_COUNT_XML: 4, PATIENT_GENDER_COUNT_XML: 5, PATIENT_VITALSTATUS_COUNT_XML: 6,
  PATIENT_RACE_COUNT_XML: 7, PATIENT_AGE_COUNT_XML: 8,
};
export const RESULT_DESCRIPTIONS: Record<string, string> = {
  PATIENTSET: 'Patient set', PATIENT_COUNT_XML: 'Number of patients', PATIENT_GENDER_COUNT_XML: 'Gender patient breakdown',
  PATIENT_VITALSTATUS_COUNT_XML: 'Vital Status patient breakdown', PATIENT_RACE_COUNT_XML: 'Race patient breakdown',
  PATIENT_AGE_COUNT_XML: 'Age patient breakdown',
};
export const BREAKDOWN_PATHS: [string, string][] = [
  ['PATIENT_GENDER_COUNT_XML', '\\i2b2\\Demographics\\Sex\\'],
  ['PATIENT_AGE_COUNT_XML', '\\i2b2\\Demographics\\Age\\'],
  ['PATIENT_RACE_COUNT_XML', '\\i2b2\\Demographics\\Race\\'],
  ['PATIENT_VITALSTATUS_COUNT_XML', '\\i2b2\\Demographics\\Vital Status\\'],
];

/** A standard normal draw (Box-Muller) from the system's cryptographic generator, like Python's SystemRandom.gauss. */
function gauss(): number {
  const u = (randomInt(1, 2 ** 47) / 2 ** 47);
  const v = (randomInt(0, 2 ** 47) / 2 ** 47);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** i2b2 CRC GaussianBoxMuller.getNormalizedValueForCount(count, sigma, minimum). */
export function obfuscate(count: number, sigma: number): number {
  if (count <= MINIMUM) return 0;
  const noisy = Math.round(count + gauss() * sigma);
  return noisy > 0 ? noisy : 0;
}

export function display(setSize: number): string {
  return setSize < OBFUSCATED_DISPLAY + 1 ? `Fewer than ${OBFUSCATED_DISPLAY + 1}` : `${setSize} ±${OBFUSCATED_DISPLAY}`;
}

/** i2b2 result message (i2b2_result_msg.xsd), as stored in QT_XML_RESULT.XML_VALUE. */
export function resultXml(resultType: string, cells: [string, number][]): string {
  const data = cells.map(([c, n]) => `<data type="int" column="${escapeXml(c).replace(/"/g, '&quot;')}">${n}</data>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<ns10:i2b2_result_envelope xmlns:ns10="http://www.i2b2.org/xsd/hive/msg/result/1.1/">'
    + `<body><ns10:result name="${resultType}">${data}</ns10:result></body></ns10:i2b2_result_envelope>`;
}

/** The CRC_QRY_runQueryInstance_fromQueryDefinition request body (stored in I2B2_REQUEST_XML). */
export function requestMessage(queryDefinitionXml: string, user: string, outputs: string[]): string {
  const results = outputs.map((o, i) => `<result_output priority_index="${i + 1}" name="${o.toLowerCase()}"/>`).join('');
  return `<ns4:psmheader><user group="${PROJECT}" login="${escapeXml(user)}">${escapeXml(user)}</user>`
    + '<patient_set_limit>0</patient_set_limit><estimated_time>0</estimated_time>'
    + '<query_mode>optimize_without_temp_table</query_mode>'
    + '<request_type>CRC_QRY_runQueryInstance_fromQueryDefinition</request_type></ns4:psmheader>'
    + '<ns4:request xsi:type="ns4:query_definition_requestType" '
    + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' + queryDefinitionXml
    + `<result_output_list>${results}</result_output_list></ns4:request>`;
}
