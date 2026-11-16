import { itemConstraints, itemName, panelTags, type QueryDefinition } from '@/lib/format';

/** The i2b2 query as panels: AND between panels, OR between the items in a panel, NOT for an inverted panel. */
export function QueryPanels({ definition }: { definition: QueryDefinition }) {
  return (
    <div className="panels">
      {definition.panels.map((panel, i) => {
        const tags = panelTags(panel, definition.query_timing);
        return (
          <div key={i} style={{ display: 'contents' }}>
            {i > 0 ? <span className={`joiner${panel.invert ? ' not' : ''}`}>{panel.invert ? 'AND NOT' : 'AND'}</span> : null}
            <div className={`panel${panel.invert ? ' not' : ''}`}>
              <div className="panel-head">
                <span>Panel {i + 1}</span>
                <span className="panel-tags">
                  {tags.map((t) => (
                    <span key={t} className={`tag${t === 'NOT' ? ' tag-not' : ''}`}>{t}</span>
                  ))}
                </span>
              </div>
              {panel.items.map((item, j) => (
                <div key={j}>
                  {j > 0 ? <div className="or">or</div> : null}
                  <div className="chip" title={item.item_key}>
                    <span className="chip-body">
                      <span className="chip-name">{itemName(item)}</span>
                      {itemConstraints(item).map((c) => (
                        <span key={c} className="chip-cons">{c}</span>
                      ))}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
