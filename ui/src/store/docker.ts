// Docker for the Services window: containers, images and Compose services, their actions (through the docker CLI as
// processes, so the output shows in the Build / Run windows), and Run / Debug of a project in a container.
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import { dirname } from '../lib/paths';
import { startDebugging } from './debug';
import { useEditors } from './editors';
import { runAndWait, useProcs } from './procs';
import { useSettings } from './settings';
import { askConfirm, toast, useUi } from './ui';
import { startupProject, useWorkspace } from './workspace';

export interface DockerInfo {
  installed: boolean;
  running: boolean;
  version?: string;
  serverArch?: string;
  error?: string;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  composeProject?: string;
  composeService?: string;
  composeFile?: string;
}

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;
}

export interface ComposeFile {
  path: string;
  project: string;
  services: string[];
}

interface DockerState {
  info: DockerInfo | null;
  containers: Container[];
  images: DockerImage[];
  compose: ComposeFile[];
  loading: boolean;
}

export const useDocker = create<DockerState>(() => ({ info: null, containers: [], images: [], compose: [], loading: false }));

export async function refreshDocker(): Promise<void> {
  if (useDocker.getState().loading) return;
  useDocker.setState({ loading: true });
  try {
    const [info, compose] = await Promise.all([api.get<DockerInfo>('/docker/info'), api.get<ComposeFile[]>('/docker/compose').catch(() => [])]);
    if (!info.running) {
      useDocker.setState({ info, compose, containers: [], images: [], loading: false });
      return;
    }
    const [containers, images] = await Promise.all([api.get<Container[]>('/docker/containers'), api.get<DockerImage[]>('/docker/images')]);
    useDocker.setState({ info, compose, containers, images, loading: false });
  } catch (e) {
    useDocker.setState({ loading: false, info: { installed: true, running: false, error: errorText(e) } });
  }
}

const root = () => useWorkspace.getState().ws.root ?? undefined;

async function docker(title: string, args: string[], cwd = root()): Promise<boolean> {
  const r = await runAndWait({ kind: 'docker', title, file: 'docker', args, cwd });
  void refreshDocker();
  if (r?.exitCode === 0) return true;
  useUi.getState().toast({ kind: 'error', text: `${title} failed`, detail: 'See the Build window for docker’s output.', action: { label: 'Show output', run: () => useUi.getState().showBottom('build') } }, 8000);
  return false;
}

export async function containerAction(c: Container, action: 'start' | 'stop' | 'restart' | 'rm'): Promise<void> {
  if (action === 'rm' && (await askConfirm({ title: 'Remove container', message: `Remove ${c.name}${c.state === 'running' ? ' (it is running: it will be stopped)' : ''}?`, okLabel: 'Remove', danger: true })) !== 'ok') return;
  await docker(`docker ${action} ${c.name}`, action === 'rm' ? ['rm', '-f', c.id] : [action, c.id]);
}

/** Follows the container's log in the Run window. */
export function containerLogs(c: Container): void {
  void useProcs.getState().start({ kind: 'docker-run', title: `${c.name} logs`, file: 'docker', args: ['logs', '-f', '--tail', '500', c.id], cwd: root() });
  useUi.getState().showBottom('run');
}

/** A terminal inside the container (bash when it has one, else sh). */
export async function containerShell(c: Container): Promise<void> {
  const { newTerminal } = await import('./terminals');
  await newTerminal(undefined, { shell: 'docker', args: ['exec', '-it', c.id, 'sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'], title: c.name });
}

export async function removeImage(img: DockerImage): Promise<void> {
  const name = img.repository === '<none>' ? img.id : `${img.repository}:${img.tag}`;
  if ((await askConfirm({ title: 'Remove image', message: `Remove ${name}?`, okLabel: 'Remove', danger: true })) !== 'ok') return;
  await docker(`docker rmi ${name}`, ['rmi', img.id]);
}

/** docker compose up / down / start / stop / restart / pull, for the whole file or one service. */
export async function compose(file: ComposeFile, action: 'up' | 'down' | 'start' | 'stop' | 'restart' | 'pull' | 'build', service?: string): Promise<void> {
  const args = ['compose', '-f', file.path, action];
  if (action === 'up') args.push('-d', '--remove-orphans');
  if (service) args.push(service);
  await docker(`compose ${action}${service ? ` ${service}` : ''}`, args, dirname(file.path));
}

export function composeLogs(file: ComposeFile, service?: string): void {
  void useProcs.getState().start({ kind: 'docker-run', title: `${service ?? file.project} logs`, file: 'docker', args: ['compose', '-f', file.path, 'logs', '-f', '--tail', '300', ...(service ? [service] : [])], cwd: dirname(file.path) });
  useUi.getState().showBottom('run');
}

// ---------------------------------------------------------------- run / debug a project in a container

interface DockerProject {
  project: string;
  dockerfile?: string;
  context?: string;
  ports: number[];
  hasBaseStage: boolean;
  imageName: string;
}

function projectPath(path?: string): string | undefined {
  return path ?? startupProject()?.path;
}

/** Builds the project's Dockerfile and runs the image (ports from EXPOSE), its output in the Run window. */
export async function runInDocker(path?: string): Promise<void> {
  const p = projectPath(path);
  if (!p) {
    toast('info', 'Choose a run configuration first');
    return;
  }
  const info = await api.get<DockerInfo>('/docker/info').catch(() => null);
  if (!info?.running) {
    toast('error', 'Docker is not running', info?.error ?? 'Start Docker Desktop (or your Docker daemon).');
    return;
  }
  const proj = await api.get<DockerProject>('/docker/project', { path: p });
  if (!proj.dockerfile) {
    toast('warning', 'This project has no Dockerfile', 'Add a Dockerfile next to the .csproj to run it in a container.');
    return;
  }
  if (useSettings.getState().settings.saveBeforeBuild) await useEditors.getState().saveAll();
  const image = `${proj.imageName}:dev`;
  if (!(await docker(`docker build ${image}`, ['build', '-t', image, '-f', proj.dockerfile, proj.context!]))) return;
  await runAndWait({ kind: 'docker', title: 'remove old container', file: 'docker', args: ['rm', '-f', proj.imageName], cwd: root() });
  const ports = proj.ports.flatMap((n) => ['-p', `${n}:${n}`]);
  void useProcs.getState().start({ kind: 'docker-run', title: `${proj.imageName} (Docker)`, file: 'docker', args: ['run', '--rm', '--name', proj.imageName, ...ports, '-e', 'ASPNETCORE_ENVIRONMENT=Development', image], cwd: root() });
  useUi.getState().showBottom('run');
  if (proj.ports.length) toast('info', `Listening in the container on ${proj.ports.join(', ')}`, proj.ports.map((n) => `http://localhost:${n}`).join('  '), 6000);
  void refreshDocker();
}

/** Debugs the project inside a container (the Dockerfile's base stage with the local build mounted). */
export async function debugInDocker(path?: string): Promise<void> {
  const p = projectPath(path);
  if (!p) {
    toast('info', 'Choose a run configuration first');
    return;
  }
  await startDebugging(p, { docker: true });
}

/** Stops the container started by Run in Docker (stopping the Run window's process only detaches from it). */
export async function stopDockerRun(path?: string): Promise<void> {
  const p = projectPath(path);
  if (!p) return;
  const proj = await api.get<DockerProject>('/docker/project', { path: p });
  await docker(`docker stop ${proj.imageName}`, ['rm', '-f', proj.imageName]);
}

