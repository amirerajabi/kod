import { useMemo, useState, type ReactNode } from 'react';
import {
  generateTitle,
  runRefactoring,
  useGenerate,
  type ExtractClassInfoDto,
  type GenerateInfoDto,
  type GenerateKind,
  type InlineInfoDto,
  type MovableMemberDto,
  type MoveMembersInfoDto,
  type MoveTypeInfoDto,
} from '../editor/generate';
import type { At } from '../editor/refactor';
import { basename, relative } from '../lib/paths';
import { useWorkspace } from '../store/workspace';
import { Dialog } from './common/Dialog';

/** The dialog of the Generate action or type / member refactoring in progress. */
export function GenerateDialogs() {
  const d = useGenerate((s) => s.dialog);
  if (!d) return null;
  switch (d.kind) {
    case 'generate':
      return <GenerateDialog key={d.what} at={d.at} info={d.info} what={d.what} />;
    case 'moveType':
      return <MoveTypeDialog at={d.at} info={d.info} />;
    case 'pullUp':
      return <MoveMembersDialog at={d.at} info={d.info} up />;
    case 'pushDown':
      return <MoveMembersDialog at={d.at} info={d.info} up={false} />;
    case 'inlineMethod':
      return <InlineMethodDialog at={d.at} info={d.info} />;
    case 'inlineField':
      return <InlineFieldDialog at={d.at} info={d.info} />;
    case 'extractClass':
      return <ExtractClassDialog at={d.at} info={d.info} />;
  }
}

const close = () => useGenerate.getState().close();

function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (path: string, body: unknown, done: string) => {
    setBusy(true);
    setError(null);
    setError(await runRefactoring(path, body, done));
    setBusy(false);
  };
  return { busy, error, run };
}

function Footer({ busy, ok, label, onOk }: { busy: boolean; ok: boolean; label: string; onOk: () => void }) {
  return (
    <>
      <button className="btn" onClick={close}>
        Cancel
      </button>
      <button className="btn btn-primary" disabled={busy || !ok} onClick={onOk}>
        {label}
      </button>
    </>
  );
}

interface Item {
  id: string;
  label: string;
  detail?: string;
  extra?: ReactNode;
}

/** A checkbox list with All / None, like Extract Interface's. */
function MemberList({ title, items, chosen, onChange, empty }: { title: string; items: Item[]; chosen: Set<string>; onChange(s: Set<string>): void; empty: string }) {
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <span className="section-label" style={{ padding: 0 }}>
          {title} ({items.filter((i) => chosen.has(i.id)).length} of {items.length})
        </span>
        <span className="flex-1" />
        <button className="btn btn-xs btn-ghost" onClick={() => onChange(new Set(items.map((i) => i.id)))}>
          All
        </button>
        <button className="btn btn-xs btn-ghost" onClick={() => onChange(new Set())}>
          None
        </button>
      </div>
      <div className="result-list" style={{ maxHeight: 300, border: '1px solid var(--border-subtle)', borderRadius: 6 }}>
        {items.length === 0 && <div className="panel-empty">{empty}</div>}
        {items.map((m) => (
          <label key={m.id} className="result-item" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={chosen.has(m.id)} onChange={() => toggle(m.id)} />
            <span className="text" style={{ fontFamily: 'var(--font-mono)' }}>
              {m.label}
            </span>
            {m.detail && (
              <span className="muted" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                {m.detail}
              </span>
            )}
            {m.extra}
          </label>
        ))}
      </div>
    </>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

// ---------------------------------------------------------------- Generate

function GenerateDialog({ at, info, what }: { at: At; info: GenerateInfoDto; what: GenerateKind }) {
  const items: Item[] = useMemo(() => {
    const member = (m: GenerateInfoDto['members'][number]): Item => ({ id: m.id, label: `${m.type} ${m.name}`, detail: m.kind });
    switch (what) {
      case 'constructor':
        return info.members.filter((m) => m.assignable).map(member);
      case 'properties':
      case 'readonlyProperties':
        return info.fields.map(member);
      case 'dispose':
        return info.members.filter((m) => m.isDisposable).map(member);
      case 'overrides':
        return info.overridable.map((s) => ({ id: s.id, label: s.display, detail: s.owner }));
      case 'missing':
        return info.missing.map((s) => ({ id: s.id, label: s.display, detail: s.owner }));
      default:
        return info.members.map(member);
    }
  }, [info, what]);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(what === 'overrides' ? [] : items.map((i) => i.id)));
  const [nullChecks, setNullChecks] = useState(false);
  const [mutable, setMutable] = useState(what === 'properties');
  const [equatable, setEquatable] = useState(true);
  const [operators, setOperators] = useState(true);
  const { busy, error, run } = useRun();
  const title = generateTitle(what);
  const needsPick = what === 'properties' || what === 'readonlyProperties' || what === 'overrides' || what === 'missing';
  const submit = () =>
    void run('/intel/generate', { ...at, kind: what, memberIds: [...chosen], mutable, nullChecks, operators, equatable }, `Generated ${title.toLowerCase()} for ${info.typeName}`);
  const replaces = (what === 'equality' && info.hasEquals) || (what === 'formatting' && info.hasToString);
  return (
    <Dialog title={`Generate ${title} for ${info.typeName}`} onClose={close} width={600} footer={<Footer busy={busy} ok={!needsPick || chosen.size > 0} label="Generate" onOk={submit} />}>
      {replaces && <div className="muted" style={{ marginBottom: 8 }}>The existing {what === 'equality' ? 'equality members are' : 'ToString is'} replaced.</div>}
      <MemberList
        title={what === 'overrides' || what === 'missing' ? 'Members' : what === 'properties' || what === 'readonlyProperties' ? 'Fields' : 'Fields and properties'}
        items={items}
        chosen={chosen}
        onChange={setChosen}
        empty={what === 'dispose' ? 'No disposable fields: Dispose is generated empty.' : 'Nothing to choose from.'}
      />
      {what === 'constructor' && <Check label="Check reference arguments for null" checked={nullChecks} onChange={setNullChecks} />}
      {what === 'properties' && <Check label="With setters (get and set)" checked={mutable} onChange={setMutable} />}
      {what === 'equality' && (
        <>
          <Check label={`Implement IEquatable<${info.typeName}>`} checked={equatable} onChange={setEquatable} />
          <Check label="Overload == and != operators" checked={operators} onChange={setOperators} />
        </>
      )}
      {error && <div className="form-error">{error}</div>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- Move Type to Another File / Folder

/** The namespace a project folder maps to, as the engine computes it. */
function namespaceFor(info: MoveTypeInfoDto, rel: string): string {
  const parts = rel
    .split(/[\\/]/)
    .filter((p) => p && p !== '.')
    .map((p) => p.replace(/[^A-Za-z0-9_]/g, '_'))
    .map((p) => (/^\d/.test(p) ? `_${p}` : p));
  return [info.rootNamespace ?? '', ...parts].filter(Boolean).join('.');
}

function MoveTypeDialog({ at, info }: { at: At; info: MoveTypeInfoDto }) {
  const rel = (p: string) => relative(info.projectFolder, p) || '';
  const [folder, setFolder] = useState(rel(info.folder));
  const [updateNs, setUpdateNs] = useState(true);
  const { busy, error, run } = useRun();
  const ns = updateNs ? namespaceFor(info, folder) : info.namespace;
  const sep = info.projectFolder.includes('\\') ? '\\' : '/';
  const target = folder.trim() ? `${info.projectFolder}${sep}${folder.trim().replace(/[\\/]+/g, sep)}` : info.projectFolder;
  return (
    <Dialog
      title={`Move '${info.typeName}' to Another File / Folder`}
      onClose={close}
      width={560}
      footer={<Footer busy={busy} ok label="Move" onOk={() => void run('/intel/refactor/moveType', { ...at, folder: target, updateNamespace: updateNs }, `Moved ${info.typeName}`)} />}
    >
      <label className="muted" htmlFor="mt-folder">
        Folder (in the project)
      </label>
      <input id="mt-folder" className="input" list="mt-folders" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="the project folder" spellCheck={false} autoFocus />
      <datalist id="mt-folders">
        {info.folders.map((f) => (
          <option key={f} value={rel(f)} />
        ))}
      </datalist>
      <div className="muted" style={{ margin: '4px 0 6px', fontSize: 'var(--text-xs)' }}>
        New file: {folder.trim() ? `${folder.trim()}/` : ''}
        {info.typeName}.cs{info.onlyType ? ` (${basename(at.path)} is removed)` : ''}
      </div>
      <Check label="Update the namespace to match the folder (and the usings of its references)" checked={updateNs} onChange={setUpdateNs} />
      <div className="muted" style={{ marginTop: 6 }}>
        Namespace: <code>{ns || '(global)'}</code>
      </div>
      {error && <div className="form-error">{error}</div>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- Pull Members Up / Push Members Down

function MoveMembersDialog({ at, info, up }: { at: At; info: MoveMembersInfoDto; up: boolean }) {
  const root = useWorkspace((s) => s.ws.root);
  const [targetId, setTargetId] = useState(info.targets[0]?.id ?? '');
  const target = info.targets.find((t) => t.id === targetId);
  const toInterface = up && target?.kind === 'interface';
  const members = useMemo(() => info.members.filter((m) => !toInterface || m.isPublic), [info, toInterface]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [abstract, setAbstract] = useState<Set<string>>(new Set());
  const { busy, error, run } = useRun();
  const flip = (id: string) => {
    const next = new Set(abstract);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setAbstract(next);
  };
  const items: Item[] = members.map((m: MovableMemberDto) => ({
    id: m.id,
    label: m.display,
    extra:
      m.canBeAbstract && !toInterface ? (
        <label className="muted" style={{ marginLeft: 'auto', whiteSpace: 'nowrap', display: 'flex', gap: 4, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={abstract.has(m.id)} onChange={() => flip(m.id)} />
          {up ? 'make abstract' : 'keep abstract'}
        </label>
      ) : undefined,
  }));
  const ids = [...chosen].filter((id) => members.some((m) => m.id === id));
  const submit = () =>
    up
      ? void run('/intel/refactor/pullUp', { ...at, targetId, memberIds: ids, abstract: [...abstract].filter((a) => ids.includes(a)) }, `Pulled ${ids.length} member(s) up to ${target?.name}`)
      : void run('/intel/refactor/pushDown', { ...at, memberIds: ids, abstract: [...abstract].filter((a) => ids.includes(a)) }, `Pushed ${ids.length} member(s) down`);
  return (
    <Dialog
      title={up ? `Pull Members Up from ${info.typeName}` : `Push Members Down from ${info.typeName}`}
      onClose={close}
      width={640}
      footer={<Footer busy={busy} ok={ids.length > 0 && (!up || !!target)} label="Refactor" onOk={submit} />}
    >
      {up ? (
        <>
          <label className="muted" htmlFor="pu-target">
            Base type
          </label>
          <select id="pu-target" className="input" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            {info.targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.kind === 'interface' ? 'interface' : 'class'} {t.name} — {relative(root, t.path)}
              </option>
            ))}
          </select>
          <div className="muted" style={{ margin: '4px 0 10px', fontSize: 'var(--text-xs)' }}>
            {toInterface
              ? 'The interface gets the signatures; the members stay here. Other types listing the interface get stubs.'
              : 'Members move to the base class. "make abstract" leaves an override here and an abstract member there (other derived classes get stubs).'}
          </div>
        </>
      ) : (
        <div className="muted" style={{ marginBottom: 10 }}>
          Copied into {info.targets.map((t) => t.name).join(', ')}. "keep abstract" leaves an abstract declaration in {info.typeName}.
        </div>
      )}
      <MemberList title="Members" items={items} chosen={chosen} onChange={setChosen} empty={toInterface ? 'No public instance members.' : 'No members to move.'} />
      {error && <div className="form-error">{error}</div>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- Inline

function InlineMethodDialog({ at, info }: { at: At; info: InlineInfoDto }) {
  const [mode, setMode] = useState<'all' | 'keep' | 'this'>('all');
  const { busy, error, run } = useRun();
  const option = (value: typeof mode, label: string) => (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, cursor: 'pointer' }}>
      <input type="radio" name="inline-mode" checked={mode === value} onChange={() => setMode(value)} />
      {label}
    </label>
  );
  const submit = () =>
    void run('/intel/refactor/inline/calls', { ...at, keep: mode !== 'all', thisCall: mode === 'this' }, `Inlined ${info.name}`);
  return (
    <Dialog title={`Inline Method '${info.name}'`} onClose={close} width={480} footer={<Footer busy={busy} ok label="Inline" onOk={submit} />}>
      <div className="muted">
        '{info.name}' has {info.usages} {info.usages === 1 ? 'usage' : 'usages'}.
      </div>
      {option('all', 'Inline all calls and remove the method')}
      {option('keep', 'Inline all calls and keep the method')}
      {option('this', 'Inline this call only')}
      {error && <div className="form-error">{error}</div>}
    </Dialog>
  );
}

function InlineFieldDialog({ at, info }: { at: At; info: InlineInfoDto }) {
  const { busy, error, run } = useRun();
  return (
    <Dialog
      title={`Inline ${info.kind ?? 'field'} '${info.name}'`}
      onClose={close}
      width={460}
      footer={<Footer busy={busy} ok label="Inline" onOk={() => void run('/intel/refactor/inline/field', at, `Inlined ${info.name}`)} />}
    >
      <div>
        Replace {info.usages} {info.usages === 1 ? 'usage' : 'usages'} of '{info.name}' with its value and remove the declaration?
      </div>
      {error && <div className="form-error">{error}</div>}
    </Dialog>
  );
}

// ---------------------------------------------------------------- Extract Class

function ExtractClassDialog({ at, info }: { at: At; info: ExtractClassInfoDto }) {
  const root = useWorkspace((s) => s.ws.root);
  const [name, setName] = useState(info.suggestedName);
  const [field, setField] = useState(`_${info.suggestedName[0].toLowerCase()}${info.suggestedName.slice(1)}`);
  const [fieldEdited, setFieldEdited] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const { busy, error, run } = useRun();
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const rename = (n: string) => {
    setName(n);
    if (!fieldEdited && n) setField(`_${n[0].toLowerCase()}${n.slice(1)}`);
  };
  return (
    <Dialog
      title={`Extract Class from ${info.typeName}`}
      onClose={close}
      width={600}
      footer={
        <Footer
          busy={busy}
          ok={ident.test(name) && ident.test(field) && chosen.size > 0}
          label="Extract"
          onOk={() => void run('/intel/refactor/extractClass', { ...at, name, fieldName: field, memberIds: [...chosen] }, `Extracted ${name}`)}
        />
      }
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <label className="muted" htmlFor="xc-name">
            Class name
          </label>
          <input id="xc-name" className="input" value={name} onChange={(e) => rename(e.target.value)} spellCheck={false} autoFocus />
        </div>
        <div style={{ flex: 1 }}>
          <label className="muted" htmlFor="xc-field">
            Field in {info.typeName}
          </label>
          <input
            id="xc-field"
            className="input"
            value={field}
            onChange={(e) => {
              setField(e.target.value);
              setFieldEdited(true);
            }}
            spellCheck={false}
          />
        </div>
      </div>
      <div className="muted" style={{ margin: '4px 0 10px', fontSize: 'var(--text-xs)' }}>
        New file: {relative(root, info.folder) || '.'}/{name || '…'}.cs. Uses in {info.typeName} go through the field; members used elsewhere keep a delegating member.
      </div>
      <MemberList title="Members" items={info.members.map((m) => ({ id: m.id, label: m.display, detail: m.kind }))} chosen={chosen} onChange={setChosen} empty="No members to extract." />
      {error && <div className="form-error">{error}</div>}
    </Dialog>
  );
}
