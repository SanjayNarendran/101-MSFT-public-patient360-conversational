"""i2b2 query definitions: model, i2b2 XML, and compilers to DAX (semantic model) and SQL (cross-check).

A query definition follows the i2b2 CRC request format (query_definition > panel > item):
- items inside a panel are OR-ed; panels are AND-ed; an inverted panel is a NOT;
- an item is an ontology node (item_key = \\\\TABLE_CD\\path\\), optionally constrained by value, modifier or date;
- query_timing ANY (patient level) or SAMEVISIT (all panels in one encounter); panel_timing can override per panel.

Compilation is driven by the ontology metadata, like the i2b2 CRC: each node's c_tablename, c_columnname,
c_operator, c_dimcode and c_facttablecolumn say how to select its patients, encounters or facts. The JSON form used by
the tools is a direct transcription of the XML (see QueryDefinition.from_dict).
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from xml.sax.saxutils import escape

NUMERIC_OPS = {"GT": ">", "GE": ">=", "LT": "<", "LE": "<=", "EQ": "=", "NE": "<>"}
TEXT_OPS = ("EQ", "NE", "IN", "LIKE[contains]", "LIKE[begin]", "LIKE[end]", "LIKE[exact]")
TIMINGS = ("ANY", "SAMEVISIT")
FACT, PATIENT, VISIT, CONCEPT, MODIFIER = ("observation_fact", "patient_dimension", "visit_dimension",
                                           "concept_dimension", "modifier_dimension")


# --- Query definition ---------------------------------------------------------------------------------------------

@dataclass
class ValueConstraint:
    operator: str                  # GT GE LT LE EQ NE BETWEEN (NUMBER); EQ NE IN LIKE[...] (TEXT)
    value: str                     # "6", "6 and 10" for BETWEEN, "'a','b'" or "a,b" for IN
    value_type: str = "NUMBER"     # NUMBER or TEXT
    unit: str | None = None

    @classmethod
    def from_dict(cls, d: dict | None) -> ValueConstraint | None:
        if not d:
            return None
        v = cls(operator=d.get("value_operator", d.get("operator", "")).upper().replace("LIKE[", "LIKE["),
                value=str(d.get("value_constraint", d.get("value", ""))),
                value_type=d.get("value_type", "NUMBER").upper(), unit=d.get("value_unit_of_measure", d.get("unit")))
        if v.value_type == "NUMBER" and v.operator not in (*NUMERIC_OPS, "BETWEEN"):
            raise ValueError(f"Unsupported numeric operator {v.operator}")
        if v.value_type == "TEXT" and v.operator not in TEXT_OPS:
            raise ValueError(f"Unsupported text operator {v.operator}")
        return v

    def numbers(self) -> list[float]:
        parts = re.split(r"\s+and\s+", self.value.strip(), flags=re.I) if self.operator == "BETWEEN" else [self.value]
        return [float(p) for p in parts]

    def texts(self) -> list[str]:
        return [t.strip().strip("'\"") for t in self.value.split(",")] if self.operator == "IN" else [self.value]

    def to_dict(self) -> dict:
        return {"value_operator": self.operator, "value_constraint": self.value, "value_type": self.value_type,
                **({"value_unit_of_measure": self.unit} if self.unit else {})}


@dataclass
class ModifierConstraint:
    modifier_key: str
    modifier_name: str = ""
    applied_path: str = ""
    value: ValueConstraint | None = None

    @classmethod
    def from_dict(cls, d: dict | None) -> ModifierConstraint | None:
        if not d:
            return None
        return cls(modifier_key=d["modifier_key"], modifier_name=d.get("modifier_name", ""),
                   applied_path=d.get("applied_path", ""), value=ValueConstraint.from_dict(d.get("constrain_by_value")))


@dataclass
class Item:
    item_key: str
    item_name: str = ""
    value: ValueConstraint | None = None
    modifier: ModifierConstraint | None = None
    date_from: str | None = None   # YYYY-MM-DD, on observation_fact.start_date
    date_to: str | None = None

    @classmethod
    def from_dict(cls, d: dict) -> Item:
        date = d.get("constrain_by_date") or {}
        return cls(item_key=d["item_key"], item_name=d.get("item_name", ""),
                   value=ValueConstraint.from_dict(d.get("constrain_by_value")),
                   modifier=ModifierConstraint.from_dict(d.get("constrain_by_modifier")),
                   date_from=date.get("date_from"), date_to=date.get("date_to"))


@dataclass
class Panel:
    items: list[Item]
    invert: bool = False
    timing: str = "ANY"
    occurrences: int = 1           # total_item_occurrences
    date_from: str | None = None   # panel_date_from / panel_date_to
    date_to: str | None = None

    @classmethod
    def from_dict(cls, d: dict, default_timing: str = "ANY") -> Panel:
        p = cls(items=[Item.from_dict(i) for i in d["items"]], invert=bool(int(d.get("invert", 0))),
                timing=(d.get("panel_timing") or default_timing).upper(), occurrences=int(d.get("total_item_occurrences", 1)),
                date_from=d.get("panel_date_from"), date_to=d.get("panel_date_to"))
        if not p.items:
            raise ValueError("A panel needs at least one item")
        if p.timing not in TIMINGS:
            raise ValueError(f"Unsupported panel_timing {p.timing}")
        return p


@dataclass
class QueryDefinition:
    panels: list[Panel]
    name: str = ""
    timing: str = "ANY"
    specificity_scale: int = 0

    @classmethod
    def from_dict(cls, d: dict) -> QueryDefinition:
        timing = (d.get("query_timing") or "ANY").upper()
        q = cls(panels=[Panel.from_dict(p, timing) for p in d["panels"]], name=d.get("query_name", ""),
                timing=timing, specificity_scale=int(d.get("specificity_scale", 0)))
        if not q.panels:
            raise ValueError("A query needs at least one panel")
        if q.timing not in TIMINGS:
            raise ValueError(f"Unsupported query_timing {q.timing}")
        return q

    def panel_timing(self, p: Panel) -> str:
        """A panel is joined on the encounter only when both the query and the panel are SAMEVISIT (as in i2b2)."""
        return "SAMEVISIT" if self.timing == "SAMEVISIT" and p.timing == "SAMEVISIT" else "ANY"

    def to_dict(self) -> dict:
        def item(i: Item) -> dict:
            out = {"item_key": i.item_key, "item_name": i.item_name}
            if i.value:
                out["constrain_by_value"] = i.value.to_dict()
            if i.modifier:
                out["constrain_by_modifier"] = {"modifier_key": i.modifier.modifier_key,
                                                "modifier_name": i.modifier.modifier_name,
                                                "applied_path": i.modifier.applied_path,
                                                **({"constrain_by_value": i.modifier.value.to_dict()}
                                                   if i.modifier.value else {})}
            if i.date_from or i.date_to:
                out["constrain_by_date"] = {"date_from": i.date_from, "date_to": i.date_to}
            return out
        return {"query_name": self.name, "query_timing": self.timing, "specificity_scale": self.specificity_scale,
                "panels": [{"panel_number": n, "invert": int(p.invert), "panel_timing": p.timing,
                            "total_item_occurrences": p.occurrences, "panel_date_from": p.date_from,
                            "panel_date_to": p.date_to, "items": [item(i) for i in p.items]}
                           for n, p in enumerate(self.panels, start=1)]}

    def auto_name(self, at: float | None = None) -> str:
        """As the i2b2 web client names queries: each panel's first item cut to 15 / panels characters, joined
        with '-', then @HH:MM:SS (i2b2-webclient-classic CRC_ctrlr_QryTool.js)."""
        size = max(1, 15 // len(self.panels))
        parts = [(p.items[0].item_name or p.items[0].item_key.rstrip("\\").split("\\")[-1])[:size]
                 for p in self.panels]
        return "-".join(parts) + time.strftime("@%H:%M:%S", time.localtime(at))

    def normalize(self, ontology: Ontology) -> QueryDefinition:
        """Checks every item against the ontology and fills canonical item keys and names (in place)."""
        for p in self.panels:
            for i in p.items:
                node = ontology.node(i.item_key)
                i.item_key, i.item_name = ontology.key(node.fullname), i.item_name or node.name
                if i.modifier:
                    m = ontology.node(i.modifier.modifier_key)
                    i.modifier.modifier_key = ontology.key(m.fullname)
                    i.modifier.modifier_name = i.modifier.modifier_name or m.name
                    i.modifier.applied_path = i.modifier.applied_path or node.fullname + "%"
        if not self.name:
            self.name = self.auto_name()
        return self



# --- Ontology -------------------------------------------------------------------------------------------------------

@dataclass
class Node:
    fullname: str
    name: str
    tablename: str
    columnname: str
    operator: str
    dimcode: str
    datatype: str
    facttablecolumn: str
    basecode: str | None
    visual: str
    hlevel: int
    totalnum: int | None = None
    metadataxml: str | None = None
    applied_path: str | None = None


@dataclass
class Ontology:
    nodes: dict[str, Node]                 # by c_fullname
    tables: dict[str, str] = field(default_factory=dict)   # c_table_cd -> top-level c_fullname

    @classmethod
    def from_rows(cls, ontology: list[dict], table_access: list[dict]) -> Ontology:
        nodes = {r["c_fullname"]: Node(
            fullname=r["c_fullname"], name=r["c_name"], tablename=r["c_tablename"].lower(),
            columnname=r["c_columnname"].lower(), operator=r["c_operator"].upper(), dimcode=r["c_dimcode"],
            datatype=r["c_columndatatype"], facttablecolumn=r["c_facttablecolumn"].lower(),
            basecode=r.get("c_basecode"), visual=r["c_visualattributes"], hlevel=int(r["c_hlevel"]),
            totalnum=r.get("c_totalnum"), metadataxml=r.get("c_metadataxml"),
            applied_path=r.get("m_applied_path")) for r in ontology}
        return cls(nodes, {r["c_table_cd"]: r["c_fullname"] for r in table_access})

    def key(self, fullname: str) -> str:
        r"""item_key (\\TABLE_CD\path\) for an ontology path."""
        table = max((cd for cd, root in self.tables.items() if fullname.startswith(root)),
                    key=lambda cd: len(self.tables[cd]), default=None)
        if table is None and fullname.startswith("\\") and not fullname.startswith("\\i2b2\\"):
            table = "i2b2_modifiers"
        return f"\\\\{table}{fullname}"

    def node(self, item_key: str) -> Node:
        r"""Accepts \\TABLE_CD\path\ or a bare path."""
        path = item_key
        m = re.match(r"^\\\\[^\\]+(\\.*)$", item_key)
        if m:
            path = m.group(1)
        if not path.endswith("\\"):
            path += "\\"
        if path not in self.nodes:
            raise KeyError(f"Unknown ontology item {item_key!r}")
        return self.nodes[path]

    def children(self, fullname: str) -> list[Node]:
        level = fullname.count("\\")
        return sorted((n for p, n in self.nodes.items() if p.startswith(fullname) and p.count("\\") == level + 1),
                      key=lambda n: n.name)

    def search(self, text: str, limit: int = 25, under: str | None = None) -> list[Node]:
        words = [w for w in re.split(r"\W+", text.lower()) if w]
        hits = [n for n in self.nodes.values() if (not under or n.fullname.startswith(under))
                and all(w in (n.name + " " + (n.basecode or "")).lower() for w in words)]
        return sorted(hits, key=lambda n: (-(n.totalnum or 0), n.hlevel))[:limit]


# --- XML (the i2b2 request message body) ----------------------------------------------------------------------------

def to_xml(q: QueryDefinition, ontology: Ontology | None = None) -> str:
    def tag(name, value, indent):
        return f"{' ' * indent}<{name}>{escape(str(value))}</{name}>\n" if value not in (None, "") else ""

    def value_xml(v: ValueConstraint, indent: int, name: str = "constrain_by_value") -> str:
        pad = " " * indent
        return (f"{pad}<{name}>\n" + tag("value_operator", v.operator, indent + 2)
                + tag("value_constraint", v.value, indent + 2) + tag("value_unit_of_measure", v.unit, indent + 2)
                + tag("value_type", v.value_type, indent + 2) + f"{pad}</{name}>\n")

    out = ['<query_definition>\n', tag("query_name", q.name, 2), tag("query_timing", q.timing, 2),
           tag("specificity_scale", q.specificity_scale, 2)]
    for n, p in enumerate(q.panels, start=1):
        out += ["  <panel>\n", tag("panel_number", n, 4), tag("panel_date_from", p.date_from, 4),
                tag("panel_date_to", p.date_to, 4), tag("panel_accuracy_scale", 100, 4),
                tag("invert", int(p.invert), 4), tag("panel_timing", p.timing, 4),
                tag("total_item_occurrences", p.occurrences, 4)]
        for i in p.items:
            node = ontology.node(i.item_key) if ontology else None
            out += ["    <item>\n", tag("hlevel", node.hlevel if node else "", 6),
                    tag("item_name", i.item_name or (node.name if node else ""), 6),
                    tag("item_key", i.item_key if i.item_key.startswith("\\\\") or not ontology
                        else ontology.key(node.fullname), 6),
                    tag("tooltip", node.name if node else "", 6), tag("class", "ENC", 6),
                    tag("item_icon", node.visual.strip() if node else "", 6), tag("item_is_synonym", "false", 6)]
            if i.value:
                out.append(value_xml(i.value, 6))
            if i.date_from or i.date_to:
                out += ["      <constrain_by_date>\n", tag("date_from", i.date_from, 8), tag("date_to", i.date_to, 8),
                        "      </constrain_by_date>\n"]
            if i.modifier:
                m = i.modifier
                out += ["      <constrain_by_modifier>\n", tag("modifier_name", m.modifier_name, 8),
                        tag("applied_path", m.applied_path, 8), tag("modifier_key", m.modifier_key, 8)]
                if m.value:
                    out.append(value_xml(m.value, 8))
                out.append("      </constrain_by_modifier>\n")
            out.append("    </item>\n")
        out.append("  </panel>\n")
    out.append("</query_definition>\n")
    return "".join(out)


# --- DAX compiler ---------------------------------------------------------------------------------------------------

def _dax_str(s: str) -> str:
    return '"' + s.replace('"', '""') + '"'


def _dax_date(d: str) -> str:
    y, m, day = (int(x) for x in d[:10].split("-"))
    return f"DATE({y}, {m}, {day})"


def _col(table: str, column: str) -> str:
    return f"'{table}'[{column}]"


class DaxCompiler:
    """Builds DAX table expressions. Every expression returns named columns [patient_num] (and [encounter_num] at
    visit level), so sets can be combined with UNION / INTERSECT / EXCEPT."""

    def __init__(self, ontology: Ontology):
        self.ontology = ontology

    def _codes(self, node: Node) -> str:
        path = node.dimcode if node.operator == "LIKE" else node.fullname
        return (f"SELECTCOLUMNS(FILTER(ALL({_col(CONCEPT, 'concept_path')}, {_col(CONCEPT, 'concept_cd')}), "
                f"LEFT({_col(CONCEPT, 'concept_path')}, {len(path)}) = {_dax_str(path)}), "
                f"\"concept_cd\", {_col(CONCEPT, 'concept_cd')})")

    def _modifier_codes(self, m: ModifierConstraint) -> str:
        node = self.ontology.node(m.modifier_key)
        return (f"SELECTCOLUMNS(FILTER(ALL({_col(MODIFIER, 'modifier_path')}, {_col(MODIFIER, 'modifier_cd')}), "
                f"LEFT({_col(MODIFIER, 'modifier_path')}, {len(node.fullname)}) = {_dax_str(node.fullname)}), "
                f"\"modifier_cd\", {_col(MODIFIER, 'modifier_cd')})")

    @staticmethod
    def _value_filters(v: ValueConstraint | None) -> list[str]:
        if not v:
            return []
        if v.value_type == "NUMBER":
            nv = _col(FACT, "nval_num")
            if v.operator == "BETWEEN":
                lo, hi = v.numbers()
                return [f"{_col(FACT, 'valtype_cd')} = \"N\"", f"KEEPFILTERS({nv} >= {lo} && {nv} <= {hi})"]
            return [f"{_col(FACT, 'valtype_cd')} = \"N\"", f"{nv} {NUMERIC_OPS[v.operator]} {v.numbers()[0]}"]
        tv = _col(FACT, "tval_char")
        if v.operator == "IN":
            return [f"{tv} IN {{{', '.join(_dax_str(t) for t in v.texts())}}}"]
        if v.operator.startswith("LIKE"):
            kind = v.operator[5:-1]
            text = _dax_str(v.value)
            return [{"contains": f"KEEPFILTERS(CONTAINSSTRING({tv}, {text}))",
                     "begin": f"KEEPFILTERS(LEFT({tv}, {len(v.value)}) = {text})",
                     "end": f"KEEPFILTERS(RIGHT({tv}, {len(v.value)}) = {text})",
                     "exact": f"{tv} = {text}"}[kind]]
        return [f"{tv} {NUMERIC_OPS[v.operator]} {_dax_str(v.value)}"]

    @staticmethod
    def _date_filters(date_from: str | None, date_to: str | None) -> list[str]:
        out = []
        if date_from:
            out.append(f"{_col(FACT, 'start_date')} >= {_dax_date(date_from)}")
        if date_to:
            out.append(f"{_col(FACT, 'start_date')} < {_dax_date(date_to)} + 1")
        return out

    def _fact_set(self, filters: list[str], visit: bool, counted: bool) -> str:
        cols = [f'"patient_num", {_col(FACT, "patient_num")}']
        group = [_col(FACT, "patient_num")]
        if visit:
            cols.append(f'"encounter_num", {_col(FACT, "encounter_num")}')
            group.append(_col(FACT, "encounter_num"))
        body = f"SUMMARIZE('{FACT}', {', '.join(group)})"
        if counted:
            body = f"ADDCOLUMNS({body}, \"n\", CALCULATE(COUNTROWS('{FACT}')))"
            cols.append('"n", [n]')
        return f"SELECTCOLUMNS(CALCULATETABLE({body}, {', '.join(filters)}), {', '.join(cols)})"

    def item(self, item: Item, panel: Panel, visit: bool, counted: bool = False) -> str:
        node = self.ontology.node(item.item_key)
        dates = self._date_filters(item.date_from or panel.date_from, item.date_to or panel.date_to)
        if node.tablename == CONCEPT:
            base = [f"TREATAS({self._codes(node)}, {_col(FACT, 'concept_cd')})"] + dates
            if item.modifier:
                key = ["patient_num", "encounter_num", "provider_id", "start_date", "instance_num"]
                tuples = lambda flt: (f"CALCULATETABLE(SUMMARIZE('{FACT}', {', '.join(_col(FACT, k) for k in key)}), "
                                      f"{', '.join(flt)})")
                facts = tuples(base + [f"{_col(FACT, 'modifier_cd')} = \"@\""] + self._value_filters(item.value))
                mods = tuples(base + [f"TREATAS({self._modifier_codes(item.modifier)}, {_col(FACT, 'modifier_cd')})"]
                              + self._value_filters(item.modifier.value))
                cols = ['"patient_num", [patient_num]'] + (['"encounter_num", [encounter_num]'] if visit else [])
                if counted:
                    return (f"GROUPBY(SELECTCOLUMNS(INTERSECT({facts}, {mods}), {', '.join(cols)}), [patient_num]"
                            f"{', [encounter_num]' if visit else ''}, \"n\", COUNTX(CURRENTGROUP(), 1))")
                return f"DISTINCT(SELECTCOLUMNS(INTERSECT({facts}, {mods}), {', '.join(cols)}))"
            filters = base + [f"{_col(FACT, 'modifier_cd')} = \"@\""] + self._value_filters(item.value)
            return self._fact_set(filters, visit, counted)
        if item.value or item.modifier:
            raise ValueError(f"{node.name}: value and modifier constraints apply to concept items only")
        if node.tablename == PATIENT:
            patients = self._dimension_set(PATIENT, node, ["patient_num"])
            if not visit:
                return self._with_count(patients, counted)
            return self._with_count(
                f"SELECTCOLUMNS(CALCULATETABLE(SUMMARIZE('{VISIT}', {_col(VISIT, 'patient_num')}, "
                f"{_col(VISIT, 'encounter_num')}), TREATAS({patients}, {_col(VISIT, 'patient_num')})), "
                f"\"patient_num\", {_col(VISIT, 'patient_num')}, \"encounter_num\", {_col(VISIT, 'encounter_num')})",
                counted)
        if node.tablename == VISIT:
            if counted and not visit:   # occurrences of a visit item = number of matching visits
                pairs = self._dimension_set(VISIT, node, ["patient_num", "encounter_num"])
                return f"GROUPBY({pairs}, [patient_num], \"n\", COUNTX(CURRENTGROUP(), 1))"
            keys = ["patient_num", "encounter_num"] if visit else ["patient_num"]
            return self._with_count(self._dimension_set(VISIT, node, keys), counted)
        raise ValueError(f"{node.name}: unsupported ontology table {node.tablename}")

    @staticmethod
    def _with_count(expr: str, counted: bool) -> str:
        return f"ADDCOLUMNS({expr}, \"n\", 1)" if counted else expr

    @staticmethod
    def _dimension_set(table: str, node: Node, keys: list[str]) -> str:
        column = _col(table, node.columnname)
        if node.operator == "IN":            # folder over the whole dimension
            condition = None
        elif node.operator == "BETWEEN":
            lo, hi = (float(x) for x in re.split(r"\s+and\s+", node.dimcode, flags=re.I))
            condition = f"KEEPFILTERS({column} >= {lo} && {column} <= {hi})"
        elif node.operator == "=":
            value = node.dimcode if node.datatype == "N" else _dax_str(node.dimcode)
            condition = f"{column} = {value}"
        elif node.operator == "LIKE":
            condition = f"KEEPFILTERS(LEFT({column}, {len(node.dimcode)}) = {_dax_str(node.dimcode)})"
        else:
            raise ValueError(f"Unsupported operator {node.operator} on {node.fullname}")
        body = f"SUMMARIZE('{table}', {', '.join(_col(table, k) for k in keys)})"
        # A whole dimension includes the blank member Direct Lake adds for unmatched fact keys; leave it out
        condition = condition or f"NOT ISBLANK({_col(table, keys[0])})"
        body = f"CALCULATETABLE({body}, {condition})"
        return f"SELECTCOLUMNS({body}, {', '.join(f'{chr(34)}{k}{chr(34)}, {_col(table, k)}' for k in keys)})"

    def panel(self, panel: Panel, visit: bool) -> str:
        if panel.occurrences > 1:
            parts = [self.item(i, panel, visit, counted=True) for i in panel.items]
            union = parts[0] if len(parts) == 1 else f"UNION({', '.join(parts)})"
            keys = "[patient_num], [encounter_num]" if visit else "[patient_num]"
            cols = '"patient_num", [patient_num]' + (', "encounter_num", [encounter_num]' if visit else "")
            return (f"SELECTCOLUMNS(FILTER(GROUPBY({union}, {keys}, \"n\", SUMX(CURRENTGROUP(), [n])), "
                    f"[n] >= {panel.occurrences}), {cols})")
        parts = [self.item(i, panel, visit) for i in panel.items]
        return parts[0] if len(parts) == 1 else f"DISTINCT(UNION({', '.join(parts)}))"

    def cohort(self, q: QueryDefinition) -> tuple[list[tuple[str, str]], str]:
        """Returns (VAR definitions, expression of the patient set with one column [patient_num])."""
        variables, groups = [], {"ANY": ([], []), "SAMEVISIT": ([], [])}
        for n, p in enumerate(q.panels, start=1):
            timing = q.panel_timing(p)
            name = f"__panel{n}"
            variables.append((name, self.panel(p, visit=timing == "SAMEVISIT")))
            groups[timing][1 if p.invert else 0].append(name)
        sets = []
        for timing, (include, exclude) in groups.items():
            if not include and not exclude:
                continue
            visit = timing == "SAMEVISIT"
            if include:
                expr = include[0]
                for other in include[1:]:
                    expr = f"INTERSECT({expr}, {other})"
            else:
                expr = (f"SELECTCOLUMNS(CALCULATETABLE(SUMMARIZE('{VISIT}', {_col(VISIT, 'patient_num')}, "
                        f"{_col(VISIT, 'encounter_num')}), NOT ISBLANK({_col(VISIT, 'encounter_num')})), "
                        f"\"patient_num\", {_col(VISIT, 'patient_num')}, \"encounter_num\", "
                        f"{_col(VISIT, 'encounter_num')})" if visit else
                        f"SELECTCOLUMNS(ALLNOBLANKROW({_col(PATIENT, 'patient_num')}), \"patient_num\", "
                        f"{_col(PATIENT, 'patient_num')})")
            for other in exclude:
                expr = f"EXCEPT({expr}, {other})"
            if visit:
                expr = f"DISTINCT(SELECTCOLUMNS({expr}, \"patient_num\", [patient_num]))"
            sets.append(expr)
        cohort = sets[0] if len(sets) == 1 else f"INTERSECT({sets[0]}, {sets[1]})"
        return variables, cohort

    def count_query(self, q: QueryDefinition, breakdowns: dict[str, list[Node]]) -> str:
        """One DAX query: the patient count plus a count per breakdown category (each category is an ontology node)."""
        variables, cohort = self.cohort(q)
        rows = ['ROW("result_type", "PATIENT_COUNT_XML", "category", "Patient count", "set_size", '
                'COUNTROWS(__cohort))']
        for result_type, nodes in breakdowns.items():
            for node in nodes:
                category = Item(item_key=node.fullname)
                rows.append(f'ROW("result_type", {_dax_str(result_type)}, "category", {_dax_str(node.name)}, '
                            f'"set_size", COUNTROWS(INTERSECT(__cohort, '
                            f'{self.item(category, Panel(items=[category]), visit=False)})))')
        lines = ["DEFINE"] + [f"    VAR {n} = {e}" for n, e in variables] + [f"    VAR __cohort = {cohort}",
                                                                              "EVALUATE", f"UNION({', '.join(rows)})"]
        return "\n".join(lines)

    def patient_set_query(self, q: QueryDefinition) -> str:
        variables, cohort = self.cohort(q)
        return "\n".join(["DEFINE"] + [f"    VAR {n} = {e}" for n, e in variables]
                         + [f"    VAR __cohort = {cohort}", "EVALUATE __cohort", "ORDER BY [patient_num]"])


# --- SQL compiler (DuckDB / ANSI) -----------------------------------------------------------------------------------

def _sql_str(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


class SqlCompiler:
    """The same semantics in SQL, written independently of the DAX compiler to cross-check it."""

    def __init__(self, ontology: Ontology):
        self.ontology = ontology

    @staticmethod
    def _value(v: ValueConstraint | None, alias: str = "f") -> list[str]:
        if not v:
            return []
        if v.value_type == "NUMBER":
            if v.operator == "BETWEEN":
                lo, hi = v.numbers()
                return [f"{alias}.valtype_cd = 'N'", f"{alias}.nval_num BETWEEN {lo} AND {hi}"]
            return [f"{alias}.valtype_cd = 'N'", f"{alias}.nval_num {NUMERIC_OPS[v.operator]} {v.numbers()[0]}"]
        if v.operator == "IN":
            return [f"{alias}.tval_char IN ({', '.join(_sql_str(t) for t in v.texts())})"]
        if v.operator.startswith("LIKE"):
            pattern = {"contains": "%{}%", "begin": "{}%", "end": "%{}", "exact": "{}"}[v.operator[5:-1]]
            return [f"{alias}.tval_char LIKE {_sql_str(pattern.format(v.value))}"]
        return [f"{alias}.tval_char {NUMERIC_OPS[v.operator]} {_sql_str(v.value)}"]

    @staticmethod
    def _dates(date_from, date_to, alias="f") -> list[str]:
        out = []
        if date_from:
            out.append(f"{alias}.start_date >= DATE {_sql_str(date_from[:10])}")
        if date_to:
            out.append(f"{alias}.start_date < DATE {_sql_str(date_to[:10])} + INTERVAL 1 DAY")
        return out

    def item(self, item: Item, panel: Panel, visit: bool, counted: bool = False) -> str:
        node = self.ontology.node(item.item_key)
        keys = "patient_num, encounter_num" if visit else "patient_num"
        count = ", count(*) AS n" if counted else ""
        dates = self._dates(item.date_from or panel.date_from, item.date_to or panel.date_to)
        if node.tablename == CONCEPT:
            path = node.dimcode if node.operator == "LIKE" else node.fullname
            concept = (f"f.concept_cd IN (SELECT concept_cd FROM {CONCEPT} WHERE starts_with(concept_path, "
                       f"{_sql_str(path)}))")
            where = [concept, "f.modifier_cd = '@'"] + self._value(item.value) + dates
            if item.modifier:
                mnode = self.ontology.node(item.modifier.modifier_key)
                where.append(
                    f"EXISTS (SELECT 1 FROM {FACT} m WHERE m.patient_num = f.patient_num AND m.encounter_num = "
                    f"f.encounter_num AND m.provider_id = f.provider_id AND m.start_date = f.start_date AND "
                    f"m.instance_num = f.instance_num AND m.concept_cd = f.concept_cd AND m.modifier_cd IN "
                    f"(SELECT modifier_cd FROM {MODIFIER} WHERE starts_with(modifier_path, "
                    f"{_sql_str(mnode.fullname)}))"
                    + "".join(f" AND {c}" for c in self._value(item.modifier.value, "m")) + ")")
            return f"SELECT {keys}{count} FROM {FACT} f WHERE {' AND '.join(where)} GROUP BY {keys}"
        if node.tablename == PATIENT:
            cond = self._dim_condition(node)
            patients = f"SELECT patient_num FROM {PATIENT}" + (f" WHERE {cond}" if cond else "")
            if visit:
                return (f"SELECT patient_num, encounter_num{', 1 AS n' if counted else ''} FROM {VISIT} "
                        f"WHERE patient_num IN ({patients})")
            return f"SELECT patient_num{', 1 AS n' if counted else ''} FROM ({patients})"
        if node.tablename == VISIT:
            cond = self._dim_condition(node)
            where = f" WHERE {cond}" if cond else ""
            if counted and not visit:
                return f"SELECT patient_num, count(*) AS n FROM {VISIT}{where} GROUP BY patient_num"
            return f"SELECT DISTINCT {keys}{', 1 AS n' if counted else ''} FROM {VISIT}{where}"
        raise ValueError(node.tablename)

    @staticmethod
    def _dim_condition(node: Node) -> str | None:
        if node.operator == "IN":
            return None
        if node.operator == "BETWEEN":
            return f"{node.columnname} BETWEEN {node.dimcode}"
        if node.operator == "LIKE":
            return f"starts_with({node.columnname}, {_sql_str(node.dimcode)})"
        value = node.dimcode if node.datatype == "N" else _sql_str(node.dimcode)
        return f"{node.columnname} = {value}"

    def panel(self, panel: Panel, visit: bool) -> str:
        keys = "patient_num, encounter_num" if visit else "patient_num"
        if panel.occurrences > 1:
            union = " UNION ALL ".join(f"({self.item(i, panel, visit, counted=True)})" for i in panel.items)
            return f"SELECT {keys} FROM ({union}) GROUP BY {keys} HAVING sum(n) >= {panel.occurrences}"
        return " UNION ".join(f"({self.item(i, panel, visit)})" for i in panel.items)

    def cohort(self, q: QueryDefinition) -> str:
        groups = {"ANY": ([], []), "SAMEVISIT": ([], [])}
        for p in q.panels:
            timing = q.panel_timing(p)
            groups[timing][1 if p.invert else 0].append(self.panel(p, visit=timing == "SAMEVISIT"))
        sets = []
        for timing, (include, exclude) in groups.items():
            if not include and not exclude:
                continue
            visit = timing == "SAMEVISIT"
            base = (" INTERSECT ".join(f"({s})" for s in include) if include else
                    (f"SELECT patient_num, encounter_num FROM {VISIT}" if visit else
                     f"SELECT patient_num FROM {PATIENT}"))
            expr = f"({base})" + "".join(f" EXCEPT ({s})" for s in exclude)
            sets.append(f"SELECT DISTINCT patient_num FROM ({expr})" if visit else expr)
        return sets[0] if len(sets) == 1 else f"({sets[0]}) INTERSECT ({sets[1]})"


# --- Plain-language summary -----------------------------------------------------------------------------------------

SYMBOLS = {"GT": ">", "GE": "≥", "LT": "<", "LE": "≤", "EQ": "=", "NE": "≠"}


def _constraint(v: ValueConstraint) -> str:
    if v.operator == "BETWEEN":
        lo, hi = re.split(r"\s+and\s+", v.value, flags=re.I)
        text = f"between {lo} and {hi}"
    elif v.operator.startswith("LIKE"):
        text = f"{v.operator[5:-1]} '{v.value}'"
    elif v.operator == "IN":
        text = "in (" + ", ".join(v.texts()) + ")"
    else:
        text = f"{SYMBOLS.get(v.operator, v.operator)} {v.value}"
    return text + (f" {v.unit}" if v.unit else "")


def describe(q: QueryDefinition, ontology: Ontology) -> str:
    """The query in plain language, panel by panel (AND between panels, OR inside a panel)."""
    lines = []
    for n, p in enumerate(q.panels, start=1):
        terms = []
        for i in p.items:
            node = ontology.node(i.item_key)
            parent = ontology.nodes.get(node.fullname.rsplit("\\", 2)[0] + "\\")
            name = node.name
            if node.basecode and "|" in node.basecode and parent:
                name = f"{parent.name} = {node.name}"
            if i.value:
                name += f" {_constraint(i.value)}"
            if i.modifier:
                mod = ontology.node(i.modifier.modifier_key)
                name += f" ({mod.fullname.strip(chr(92)).split(chr(92))[0]}: {mod.name}"
                name += f" {_constraint(i.modifier.value)})" if i.modifier.value else ")"
            if i.date_from or i.date_to:
                name += f" [{i.date_from or '…'} to {i.date_to or '…'}]"
            terms.append(name)
        extras = []
        if p.occurrences > 1:
            extras.append(f"at least {p.occurrences} times")
        if p.date_from or p.date_to:
            extras.append(f"dated {p.date_from or '…'} to {p.date_to or '…'}")
        if q.panel_timing(p) == "SAMEVISIT":
            extras.append("in the same encounter")
        prefix = ("" if n == 1 else "AND ") + ("NOT " if p.invert else "")
        lines.append(f"{prefix}Panel {n}: " + " OR ".join(terms) + (f" ({'; '.join(extras)})" if extras else ""))
    return "\n".join(lines)
