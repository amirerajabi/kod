import { Braces, Code2, File, FileCode2, FileCog, FileJson, FileText, Folder, FolderOpen, Image, Layers, Package, Settings2, TestTube2 } from 'lucide-react';
import { basename, extname } from '../../lib/paths';

/** The Kod mark: a K on a navy tile with a warm dot (the app icon). */
export function KodMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" style={{ flexShrink: 0, display: 'block' }}>
      <defs>
        <linearGradient id="kod-tile" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--brand-tile-top)" />
          <stop offset="1" stopColor="var(--brand-tile-bottom)" />
        </linearGradient>
        <linearGradient id="kod-k" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand-k-start)" />
          <stop offset="1" stopColor="var(--brand-k-end)" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#kod-tile)" />
      <path d="M20 16v32M20 32l16-16M26 27l12 21" stroke="url(#kod-k)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <circle cx="46" cy="46" r="4" fill="var(--brand-dot)" />
    </svg>
  );
}

export function FileIcon({ path, isDir, open, size = 15 }: { path: string; isDir?: boolean; open?: boolean; size?: number }) {
  if (isDir) return open ? <FolderOpen size={size} className="ic-folder" /> : <Folder size={size} className="ic-folder" />;
  const ext = extname(path);
  const name = basename(path).toLowerCase();
  if (ext === '.cs' || ext === '.csx') return <FileCode2 size={size} className="ic-cs" />;
  if (ext === '.csproj' || ext === '.fsproj' || ext === '.vbproj') return name.includes('test') ? <TestTube2 size={size} className="ic-test" /> : <Package size={size} className="ic-proj" />;
  if (ext === '.sln' || ext === '.slnx') return <Layers size={size} className="ic-sln" />;
  if (ext === '.json') return <FileJson size={size} className="ic-json" />;
  if (['.xml', '.props', '.targets', '.config', '.resx', '.xaml', '.axaml', '.nuspec'].includes(ext)) return <FileCog size={size} className="ic-xml" />;
  if (['.razor', '.cshtml', '.html', '.htm', '.css', '.scss', '.js', '.ts', '.tsx', '.jsx'].includes(ext)) return <Code2 size={size} className="ic-web" />;
  if (ext === '.md' || ext === '.txt') return <FileText size={size} className="ic-md" />;
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp'].includes(ext)) return <Image size={size} className="ic-file" />;
  if (name.startsWith('.') || ext === '.editorconfig' || ext === '.yml' || ext === '.yaml') return <Settings2 size={size} className="ic-file" />;
  if (ext === '.fs' || ext === '.vb') return <Braces size={size} className="ic-cs" />;
  return <File size={size} className="ic-file" />;
}
