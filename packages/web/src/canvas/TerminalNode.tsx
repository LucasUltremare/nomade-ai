import { memo, useEffect, useRef, useState } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import { PROVIDER_COLORS } from '@relay/core';
import type { TerminalNode as TerminalNodeType } from './store.ts';
import { attachTerminal, getTerminal, reconnect, refit, subscribe, type TermStatus } from './terminals.ts';

export interface TerminalNodeCallbacks {
  onToggleMinimize: (id: string) => void;
  onMaximize: (id: string) => void;
  onClose: (id: string) => void;
  onSendLast: (id: string, anchor: DOMRect) => void;
  onSelection: (id: string, text: string, x: number, y: number) => void;
  hasOutgoing: (id: string) => boolean;
}

// Callbacks ficam num ref global simples: nodeTypes precisa ser estável e o React Flow clona props.
export const nodeCallbacks: { current: TerminalNodeCallbacks | null } = { current: null };

export function providerColor(provider: string): string {
  return provider === 'shell' ? '#9a9aa3' : (PROVIDER_COLORS as Record<string, string>)[provider] ?? '#9a9aa3';
}

function TerminalNodeImpl({ id, data, selected, width, height }: NodeProps<TerminalNodeType>) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TermStatus>('connecting');
  const [exitCode, setExitCode] = useState<number | undefined>(data.exitCode);
  const color = providerColor(data.provider);

  useEffect(() => {
    if (data.minimized) return;
    const host = hostRef.current;
    if (!host) return;
    const entry = getTerminal(data.sessionId);
    attachTerminal(entry, host);
    setStatus(entry.status);
    setExitCode(entry.exitCode);
    const unsub = subscribe(entry, () => {
      setStatus(entry.status);
      setExitCode(entry.exitCode);
    });
    const onMouseUp = (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      setTimeout(() => {
        const text = entry.term.getSelection();
        if (text.trim()) nodeCallbacks.current?.onSelection(id, text, ev.clientX, ev.clientY);
      }, 0);
    };
    host.addEventListener('mouseup', onMouseUp);
    return () => {
      unsub();
      host.removeEventListener('mouseup', onMouseUp);
    };
  }, [data.sessionId, data.minimized, id]);

  useEffect(() => {
    if (data.minimized) return;
    const entry = getTerminal(data.sessionId);
    refit(entry);
  }, [width, height, data.minimized, data.sessionId]);

  const alive = status !== 'exited' && data.alive;
  const hasOutgoing = nodeCallbacks.current?.hasOutgoing(id) ?? false;

  return (
    <div className={`tnode ${selected ? 'selected' : ''} ${data.minimized ? 'minimized' : ''}`} style={{ ['--pcolor' as string]: color }}>
      <NodeResizer minWidth={320} minHeight={data.minimized ? 40 : 200} isVisible={selected && !data.minimized} />
      <Handle type="target" position={Position.Left} id="in" />
      <Handle type="source" position={Position.Right} id="out" />
      <div className="tnode-header">
        <span className="dot" />
        <span className="title">{data.label}</span>
        <span className="cwd mono" title={data.cwd}>{data.cwd}</span>
        <div className="actions nodrag">
          <button
            className="btn sm"
            title={hasOutgoing ? 'Enviar última resposta para o terminal conectado' : 'Conecte este nó a outro (arraste da bolinha direita) para enviar'}
            disabled={!hasOutgoing || !alive}
            onClick={(e) => nodeCallbacks.current?.onSendLast(id, e.currentTarget.getBoundingClientRect())}
          >
            Enviar →
          </button>
          <button className="btn icon" title={data.minimized ? 'Restaurar' : 'Minimizar'} onClick={() => nodeCallbacks.current?.onToggleMinimize(id)}>
            {data.minimized ? '▢' : '–'}
          </button>
          <button className="btn icon" title="Maximizar" onClick={() => nodeCallbacks.current?.onMaximize(id)}>⤢</button>
          <button className="btn icon danger" title="Encerrar sessão" onClick={() => nodeCallbacks.current?.onClose(id)}>×</button>
        </div>
      </div>
      <div className="tnode-body nodrag nowheel" ref={hostRef}>
        <div className="tnode-status">
          <span className={`status-dot ${status}`} />
          {status === 'open' && 'conectado'}
          {status === 'connecting' && 'conectando'}
          {status === 'exited' && `encerrado (${exitCode ?? '?'})`}
          {status === 'closed' && (
            <>
              desconectado <button className="btn sm" onClick={() => reconnect(data.sessionId)}>reconectar</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export const TerminalNode = memo(TerminalNodeImpl);
