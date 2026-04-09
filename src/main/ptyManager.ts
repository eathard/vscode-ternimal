import { EventEmitter } from 'events';
import * as pty from 'node-pty';
import { SpawnRequest, DataPayload, ExitPayload, TitlePayload } from '../shared/ipcChannels';

export class PtyManager extends EventEmitter {
  private instances: Map<string, pty.IPty> = new Map();

  spawn(request: SpawnRequest): pty.IPty {
    const shell = request.shell || this.getDefaultShell();
    const name = process.platform === 'win32'
      ? 'windows-pty'
      : 'xterm-256color';

    const options: pty.IPtyForkOptions = {
      name,
      cols: request.cols || 80,
      rows: request.rows || 24,
      cwd: request.cwd || process.env.USERPROFILE || process.env.HOME,
      env: {
        ...process.env as Record<string, string>,
        ...request.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      } as Record<string, string>,
    };

    const ptyProcess = pty.spawn(shell, [], options);
    this.instances.set(request.id, ptyProcess);

    ptyProcess.onData((data: string) => {
      this.emit('data', {
        id: request.id,
        data,
      } as DataPayload);
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.instances.delete(request.id);
      this.emit('exit', {
        id: request.id,
        exitCode: exitCode ?? 0,
      } as ExitPayload);
    });

    // Track title changes from the PTY process
    const originalSetTitle = ptyProcess.process;
    const checkTitle = () => {
      const currentTitle = ptyProcess.process;
      if (currentTitle !== originalSetTitle) {
        this.emit('title', {
          id: request.id,
          title: currentTitle,
        } as TitlePayload);
      }
    };

    return ptyProcess;
  }

  write(id: string, data: string): void {
    const ptyProcess = this.instances.get(id);
    if (ptyProcess) {
      ptyProcess.write(data);
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const ptyProcess = this.instances.get(id);
    if (ptyProcess) {
      // Guard against zero/negative dimensions (from VS Code terminalProcess.ts:532-568)
      ptyProcess.resize(Math.max(cols, 1), Math.max(rows, 1));
    }
  }

  kill(id: string): void {
    const ptyProcess = this.instances.get(id);
    if (ptyProcess) {
      // Windows conpty can hang on kill - use a timeout
      if (process.platform === 'win32') {
        const timeout = setTimeout(() => {
          try {
            ptyProcess.kill();
          } catch {
            // Force kill on timeout
          }
        }, 5000);
        try {
          ptyProcess.kill();
          clearTimeout(timeout);
        } catch {
          // Process may already be dead
        }
      } else {
        ptyProcess.kill();
      }
      this.instances.delete(id);
    }
  }

  killAll(): void {
    for (const id of this.instances.keys()) {
      this.kill(id);
    }
  }

  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      // Try PowerShell first, then fall back to cmd
      const psPath = process.env.COMSPEC?.replace('cmd.exe', 'powershell\\powershell.exe');
      if (psPath) {
        return 'powershell.exe';
      }
      return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }
}
