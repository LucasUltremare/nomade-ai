import { useCallback, useEffect, useState } from 'react';
import type { DetectResult } from '@relay/core';
import { PROVIDER_COLORS } from '@relay/core';
import { api } from '../api.ts';

export function ProvidersScreen({ onOpenCanvas }: { onOpenCanvas: () => void }) {
  const [providers, setProviders] = useState<DetectResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    setError(null);
    try {
      setProviders(await api.providers(refresh));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(false), 0);
    return () => clearTimeout(t);
  }, [load]);

  const ready = providers?.filter((p) => p.installed && p.login === 'logged-in').length ?? 0;

  return (
    <div className="providers">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <h1>Assinaturas detectadas</h1>
          <p className="lead">
            O Relay usa as CLIs oficiais já logadas nesta máquina. Ele não lê nem guarda tokens: quem mantém a sessão é cada CLI.
            {providers && <> {ready} de {providers.length} prontas para uso.</>}
          </p>
        </div>
        <button className="btn" onClick={() => void load(true)} disabled={loading}>{loading ? 'verificando…' : 'Verificar de novo'}</button>
        <button className="btn primary" onClick={onOpenCanvas} disabled={ready === 0}>Abrir canvas →</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!providers && !error && <p className="muted">detectando CLIs…</p>}
      {providers && (
        <div className="provider-grid">
          {providers.map((p) => (
            <ProviderCard key={p.id} p={p} />
          ))}
        </div>
      )}
      <p className="muted small" style={{ marginTop: 24, lineHeight: 1.6 }}>
        Cada usuário é responsável por respeitar os termos de uso do próprio provedor. O Relay apenas automatiza o que você já faria
        manualmente nas CLIs, com as suas assinaturas.
      </p>
    </div>
  );
}

function ProviderCard({ p }: { p: DetectResult }) {
  const status = !p.installed ? 'missing' : p.login === 'logged-in' ? 'ready' : p.login === 'logged-out' ? 'logged-out' : 'unknown';
  return (
    <div className="provider" style={{ ['--pcolor' as string]: PROVIDER_COLORS[p.id] }}>
      <div className="name"><span className="dot" />{p.name}</div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className={`badge ${p.installed ? 'ok' : 'err'}`}>{p.installed ? 'instalada' : 'não encontrada'}</span>
        {p.installed && (
          <span className={`badge ${status === 'ready' ? 'ok' : status === 'logged-out' ? 'err' : 'warn'}`}>
            {status === 'ready' ? 'logada' : status === 'logged-out' ? 'não logada' : 'login desconhecido'}
          </span>
        )}
        {p.plan && <span className="badge">{p.plan}</span>}
      </div>
      <div className="meta">
        {p.version && <span>versão {p.version}</span>}
        {p.account && <span>{p.account}</span>}
        {p.binaryPath && <span className="mono">{p.binaryPath}</span>}
        {p.models && p.models.length > 0 && <span>modelos: {p.models.slice(0, 4).join(', ')}{p.models.length > 4 ? '…' : ''}</span>}
        {p.notes && <span>{p.notes}</span>}
      </div>
      {!p.installed && (
        <div className="hint">
          <div className="label">instalar</div>
          <code>{p.installHint}</code>
        </div>
      )}
      {p.installed && status !== 'ready' && (
        <div className="hint">
          <div className="label">logar</div>
          <code>{p.loginHint}</code>
        </div>
      )}
    </div>
  );
}
