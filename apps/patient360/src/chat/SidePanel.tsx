/**
 * The side panel: right-click anything in a record to ask Copilot about it. The page narrows as the panel slides in,
 * and the conversation can continue in the Ask tab. Shift with right-click keeps the browser's own menu.
 */
import { Maximize2, MessageSquare, RotateCcw, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Answer } from '@/chat/Answer';
import { useChat, type PanelContext } from '@/chat/ChatContext';
import { AccountLine, Composer, StarterButton } from '@/chat/Composer';
import { panelStarters } from '@/chat/starters';

const PANEL_W = 460;

export function SidePanel() {
  const chat = useChat();
  const navigate = useNavigate();
  const { open, context } = chat.panel;
  const c = chat.conversation('panel');
  const body = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(open);

  // Viewers size themselves on window resize: tell them once the page has narrowed or widened.
  useEffect(() => {
    if (open) setShown(true);
    const t = window.setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
      if (!open) setShown(false);
    }, 480);
    return () => window.clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && chat.closePanel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, chat]);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && c.busy) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [chat.version, c.busy]);

  const ask = (q: string) =>
    context &&
    void chat.send('panel', q, {
      context: context.text,
      about: `${context.eyebrow} · ${context.title}`,
    });

  return (
    <aside
      className={`side-chat${open ? ' is-open' : ''}`}
      style={{ width: open ? PANEL_W : 0 }}
      aria-hidden={!open}
      aria-label="Ask Copilot"
    >
      {shown && (
        <div className="side-chat-in" style={{ width: PANEL_W }}>
          <div className="sc-head">
            <span className="sc-title">
              <MessageSquare size={16} aria-hidden /> Ask Copilot
            </span>
            <div className="sc-actions">
              <button
                type="button"
                className="sc-icon"
                title="Continue in the Ask tab"
                disabled={!c.turns.length}
                onClick={() => {
                  chat.continueInAsk();
                  navigate('/ask');
                }}
              >
                <Maximize2 size={15} />
              </button>
              <button type="button" className="sc-icon" title="New conversation" onClick={() => chat.reset('panel')}>
                <RotateCcw size={15} />
              </button>
              <button type="button" className="sc-icon" title="Close (Esc)" onClick={chat.closePanel}>
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="sc-meta">
            <AccountLine compact />
          </div>
          <div ref={body} className="sc-body">
            <div className="sc-log">
              {c.turns.map((t) => (
                <div key={t.id} className="turn">
                  <div className="turn-msg">
                    <p className="turn-q">{t.question}</p>
                    {t.about && <p className="turn-ctx">{t.about}</p>}
                  </div>
                  <Answer turn={t} />
                </div>
              ))}
            </div>
            {context && !c.busy && (
              <div className="sc-about">
                <div key={`${context.eyebrow}${context.title}`} className="sc-ctx is-in">
                  <div className="sc-ctx-eyebrow">{context.eyebrow}</div>
                  <div className="sc-ctx-title">{context.title}</div>
                  {context.detail && <div className="sc-ctx-detail">{context.detail}</div>}
                </div>
                {chat.me?.github && (
                  <>
                    <div className="sc-suggest-label">Ask about this</div>
                    <div className="starters one">
                      {panelStarters(context.tab, context.title !== context.patientName, context.text).map((q) => (
                        <StarterButton
                          key={q}
                          q={q}
                          onAsk={(text, fill) =>
                            fill
                              ? window.dispatchEvent(
                                  new CustomEvent('p360:fill', {
                                    detail: { surface: 'panel', text },
                                  })
                                )
                              : ask(text)
                          }
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="sc-dock">
            <Composer
              surface="panel"
              placeholder="Ask about this"
              context={
                context
                  ? {
                      context: context.text,
                      about: `${context.eyebrow} · ${context.title}`,
                    }
                  : undefined
              }
            />
          </div>
        </div>
      )}
    </aside>
  );
}

/** The right-click menu in a record: ask in the side panel, or have Copilot explain the thing straight away. */
export function AskMenu({ x, y, context, onClose }: { x: number; y: number; context: PanelContext; onClose: () => void }) {
  const chat = useChat();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 12),
      y: Math.min(y, window.innerHeight - r.height - 12),
    });
  }, [x, y]);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);
  const explain = context.title !== context.patientName;
  return (
    <div ref={ref} className="ask-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      <div className="ask-menu-ctx">
        <div className="t-faint text-[11.5px]">{context.eyebrow}</div>
        <div className="truncate text-[13px] font-medium">{context.title}</div>
      </div>
      <button
        type="button"
        role="menuitem"
        className="ask-menu-item"
        onClick={() => {
          chat.openPanel(context);
          onClose();
        }}
      >
        Ask Copilot about this
      </button>
      {chat.me?.github && (
        <button
          type="button"
          role="menuitem"
          className="ask-menu-item"
          onClick={() => {
            chat.openPanel(context);
            void chat.send('panel', explain ? 'Explain this' : 'Summarise this patient', {
              context: context.text,
              about: `${context.eyebrow} · ${context.title}`,
            });
            onClose();
          }}
        >
          {explain ? 'Explain this' : 'Summarise this patient'}
        </button>
      )}
      <div className="ask-menu-hint">Shift with right-click for the browser's menu</div>
    </div>
  );
}
