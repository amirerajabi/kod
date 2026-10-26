// Settings › Appearance pickers (Rowlit): the app theme (swatch cards with a mini window, grouped by mode: one light and
// one dark favourite, so "System" switches between them) and the code theme (cards with a C# preview). Previews are
// painted from each theme's resolved tokens, not from the live document.
import { Check } from 'lucide-react';
import type { CSSProperties } from 'react';
import { isMac } from '../../platform';
import { effectiveTheme, useSettings } from '../../store/settings';
import { activeThemes } from '../../theme/applyTheme';
import { APP_THEMES, CODE_GROUPS, CODE_THEMES, MATCH_APP, matchVars, tokensOf, type AppTheme } from '../../theme/themes';

type T = Record<string, string>;

function MiniWindow({ t }: { t: T }) {
  const bar = (color: string | undefined, width: string): CSSProperties => ({ background: color, width });
  return (
    <div className="tp-window" aria-hidden="true" style={{ background: t['--bg-app'], borderColor: t['--border'] }}>
      <div className="tp-window-bar" style={{ background: t['--bg-app'] }}>
        <span className="tp-dot" style={{ background: t['--accent'] }} />
        <span className="tp-line" style={bar(t['--fg-muted'], '34%')} />
      </div>
      <div className="tp-window-body">
        <div className="tp-side" style={{ background: t['--bg-sunken'], borderColor: t['--border-subtle'] }}>
          <span className="tp-line" style={bar(t['--accent'], '70%')} />
          <span className="tp-line" style={{ ...bar(t['--fg-muted'], '60%'), boxShadow: `0 0 0 3px ${t['--bg-selected']}` }} />
          <span className="tp-line" style={bar(t['--fg-muted'], '50%')} />
        </div>
        <div className="tp-main" style={{ background: t['--ed-bg'], borderColor: t['--border-subtle'] }}>
          <span className="tp-code"><span className="tp-line" style={bar(t['--syn-keyword'], '28%')} /><span className="tp-line" style={bar(t['--syn-class'], '40%')} /></span>
          <span className="tp-code"><span className="tp-line" style={bar(t['--syn-keyword'], '22%')} /><span className="tp-line" style={bar(t['--syn-string'], '46%')} /></span>
          <span className="tp-code"><span className="tp-line" style={bar(t['--syn-method'], '36%')} /><span className="tp-line" style={bar(t['--syn-number'], '14%')} /></span>
          <span className="tp-button" style={{ background: t['--accent'] }} />
        </div>
      </div>
    </div>
  );
}

const appTokens = (a: AppTheme) => {
  const ui: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.vars)) if (!k.startsWith('--syn-')) ui[k] = v;
  return tokensOf(a.base, ui, matchVars(a));
};

export function AppThemePicker() {
  const s = useSettings((x) => x.settings);
  const shown = activeThemes(s);
  const os = isMac ? 'macOS' : 'Windows';
  const pick = (theme: AppTheme) =>
    // an explicit mode follows the pick (a dark theme in Light mode switches to Dark); "System" only stores the favourite
    useSettings.getState().update({ [theme.base === 'dark' ? 'appThemeDark' : 'appThemeLight']: theme.id, ...(s.theme !== 'system' && s.theme !== theme.base ? { theme: theme.base } : {}) });
  return (
    <div className="tp-groups">
      {(['light', 'dark'] as const).map((base) => {
        const chosen = base === 'dark' ? s.appThemeDark : s.appThemeLight;
        return (
          <div key={base} className="tp-group">
            <div className="tp-group-head">
              <span className="tp-group-title">{base === 'light' ? 'Light themes' : 'Dark themes'}</span>
              {s.theme === 'system' && <span className="tp-group-hint">Used when {os} is in {base} mode</span>}
            </div>
            <div className="tp-grid" role="radiogroup" aria-label={base === 'light' ? 'Light theme' : 'Dark theme'}>
              {APP_THEMES.filter((t) => t.base === base).map((t) => {
                const selected = chosen === t.id;
                return (
                  <button key={t.id} type="button" role="radio" aria-checked={selected} className={`tp-card${selected ? ' selected' : ''}`} onClick={() => pick(t)} title={t.description}>
                    <MiniWindow t={appTokens(t)} />
                    <span className="tp-card-text">
                      <span className="tp-card-name">
                        {t.name}
                        {shown.base === base && shown.app.id === t.id && <span className="tp-badge">In use</span>}
                      </span>
                      <span className="tp-card-desc">{t.description}</span>
                    </span>
                    {selected && (
                      <span className="tp-check" aria-hidden="true">
                        <Check size={12} strokeWidth={2.5} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CodePreview({ t }: { t: T }) {
  const c = (k: string, style: CSSProperties = {}) => ({ color: t[k], ...style });
  return (
    <pre className="tp-code-preview" aria-hidden="true" style={{ background: t['--ed-bg'], color: t['--ed-fg'], borderColor: t['--border-subtle'] }}>
      <span style={c('--syn-keyword')}>public class</span> <span style={c('--syn-class')}>Order</span> <span style={c('--syn-comment', { fontStyle: 'italic' })}>// paid</span>{'\n'}
      <span style={c('--syn-keyword')}>var</span> <span style={c('--syn-local')}>total</span> = <span style={c('--syn-local')}>items</span>.<span style={c('--syn-method')}>Sum</span>(<span style={c('--syn-number')}>10</span>);{'\n'}
      <span style={c('--syn-local')}>log</span>.<span style={c('--syn-property')}>Text</span> = <span style={c('--syn-string')}>&quot;ok&quot;</span>;
    </pre>
  );
}

export function CodeThemePicker() {
  const s = useSettings((x) => x.settings);
  const app = activeThemes(s).app;
  const pick = (id: string) => useSettings.getState().update({ codeTheme: id });
  const card = (id: string, name: string, desc: string, t: T) => (
    <button key={id} type="button" role="radio" aria-checked={s.codeTheme === id} className={`tp-card tp-card-code${s.codeTheme === id ? ' selected' : ''}`} onClick={() => pick(id)}>
      <CodePreview t={t} />
      <span className="tp-card-text">
        <span className="tp-card-name">{name}</span>
        <span className="tp-card-desc">{desc}</span>
      </span>
      {s.codeTheme === id && (
        <span className="tp-check" aria-hidden="true">
          <Check size={12} strokeWidth={2.5} />
        </span>
      )}
    </button>
  );
  return (
    <div className="tp-groups" role="radiogroup" aria-label="Code theme">
      <div className="tp-grid tp-grid-code">{card(MATCH_APP, 'Match app theme', `Follows ${app.name}`, appTokens(app))}</div>
      {CODE_GROUPS.map((g) => {
        const themes = CODE_THEMES.filter((e) => e.group === g.id).sort((a, b) => Number(a.base === 'dark') - Number(b.base === 'dark'));
        return (
          <div key={g.id} className="tp-group" role="group" aria-label={g.title}>
            <div className="tp-group-head">
              <span className="tp-group-title">{g.title}</span>
              <span className="tp-group-hint">{themes.length} themes</span>
            </div>
            <div className="tp-grid tp-grid-code tp-grid-grouped">{themes.map((e) => card(e.id, e.name, e.description, tokensOf(e.base, e.vars)))}</div>
          </div>
        );
      })}
    </div>
  );
}

export const currentBase = () => effectiveTheme();
