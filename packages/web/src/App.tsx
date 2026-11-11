import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, clearToken, readToken, saveToken } from './api.ts';
import { Home } from './screens/Home.tsx';

export function App() {
  const [token, setToken] = useState<string | null>(() => readToken());
  const [authed, setAuthed] = useState<boolean | null>(null);

  const check = useCallback(async () => {
    try {
      await api.health();
      setAuthed(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearToken();
        setToken(null);
      }
      setAuthed(false);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const t = setTimeout(() => void check(), 0);
    return () => clearTimeout(t);
  }, [token, check]);

  if (!token || authed === false) return <TokenScreen onSubmit={(t) => { saveToken(t); setToken(t); }} failed={authed === false} />;
  if (authed === null) return <div className="center muted">conectando ao Nomade…</div>;

  return <Home />;
}

function TokenScreen({ onSubmit, failed }: { onSubmit: (t: string) => void; failed: boolean }) {
  const [value, setValue] = useState('');
  return (
    <div className="center">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <h1><img className="brand-mark" src="/nomade-mark.png" alt="" /> Nomade Agents</h1>
        <p>
          O server gera um token a cada start e imprime no terminal uma URL com <code>?token=…</code>. Abra essa URL, ou cole o token
          aqui.
        </p>
        {failed && <p className="error">Token inválido ou server fora do ar. Confira o terminal onde o Nomade está rodando.</p>}
        <div className="row">
          <input className="input mono" placeholder="token" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          <button className="btn primary" type="submit">Entrar</button>
        </div>
      </form>
    </div>
  );
}
