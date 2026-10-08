/** @jsxImportSource preact */
import { settings, type SettingsContext } from '@bridgething/client/settings';
import { LOGO_URL } from '../src/logo';
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { APP_NAME, APP_VERSION, authHeader, normalizeServerUrl } from '../src/jellyfin';
import './style.css';

// The companion phone app renders this page. It signs in to Jellyfin from the
// phone and writes the resulting token into the webapp's config, which the Car
// Thing reads with `client.config`. The password itself is never stored.

type Values = Record<string, string>;
type Mode = 'password' | 'quick' | 'apikey';

function newDeviceId(): string {
  const r = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2);
  return `carthing-${r}`;
}

async function call<T>(
  server: string,
  path: string,
  deviceId: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: authHeader(deviceId, init.token),
    Accept: 'application/json',
  };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.token) headers['X-Emby-Token'] = init.token;
  let res: Response;
  try {
    res = await settings.fetch(`${server}${path}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      timeoutMs: 10_000,
    });
  } catch (err) {
    throw new Error(`Can't reach ${server}. ${err instanceof Error ? err.message : ''}`.trim());
  }
  if (res.status === 401) throw new Error('Wrong username or password.');
  if (!res.ok) throw new Error(`Server answered HTTP ${res.status}.`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

type AuthResult = { AccessToken: string; User: { Id: string; Name: string }; ServerId?: string };

function Settings() {
  const [ctx, setCtx] = useState<SettingsContext | null>(null);
  const [values, setValues] = useState<Values>({});
  const [loaded, setLoaded] = useState(false);
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [mode, setMode] = useState<Mode>('password');
  const [serverInfo, setServerInfo] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; kind: 'ok' | 'err' | 'info' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [quickCode, setQuickCode] = useState<string | null>(null);
  const quickCancel = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        setCtx(await settings.context());
        const entries = await settings.config.list();
        const v = Object.fromEntries(entries.map(e => [e.key, e.value]));
        setValues(v);
        setServer(v.server_url ?? '');
        setUsername(v.username ?? '');
      } catch (err) {
        setStatus({ text: err instanceof Error ? err.message : String(err), kind: 'err' });
      } finally {
        setLoaded(true);
      }
    })();
    return () => {
      quickCancel.current = true;
    };
  }, []);

  const signedIn = !!(values.access_token && values.user_id && values.server_url);
  const deviceId = () => values.device_id || newDeviceId();

  async function save(next: Values) {
    for (const [k, v] of Object.entries(next)) {
      if (v === '') await settings.config.delete(k).catch(() => settings.config.set(k, ''));
      else await settings.config.set(k, v);
    }
    setValues(prev => ({ ...prev, ...next }));
  }

  async function checkServer(): Promise<string | null> {
    const url = normalizeServerUrl(server);
    if (!url) {
      setStatus({ text: 'Enter your Jellyfin server address first.', kind: 'err' });
      return null;
    }
    try {
      const info = await call<{ ServerName?: string; Version?: string; ProductName?: string }>(
        url,
        '/System/Info/Public',
        deviceId(),
      );
      if (!info || (!info.Version && !info.ServerName)) throw new Error("That address doesn't look like a Jellyfin server.");
      setServerInfo(`${info.ServerName ?? 'Jellyfin'} · ${info.ProductName ?? 'Jellyfin Server'} ${info.Version ?? ''}`.trim());
      setServer(url);
      return url;
    } catch (err) {
      setServerInfo(null);
      setStatus({ text: err instanceof Error ? err.message : String(err), kind: 'err' });
      return null;
    }
  }

  async function finish(url: string, auth: AuthResult, devId: string) {
    await save({
      server_url: url,
      username: auth.User.Name,
      access_token: auth.AccessToken,
      user_id: auth.User.Id,
      device_id: devId,
    });
    setPassword('');
    setStatus({ text: `Signed in as ${auth.User.Name}. Your Car Thing is ready.`, kind: 'ok' });
  }

  async function signInPassword(e: Event) {
    e.preventDefault();
    setBusy(true);
    setStatus({ text: 'Signing in…', kind: 'info' });
    try {
      const url = await checkServer();
      if (!url) return;
      const devId = deviceId();
      const auth = await call<AuthResult>(url, '/Users/AuthenticateByName', devId, {
        body: { Username: username.trim(), Pw: password },
      });
      await finish(url, auth, devId);
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : String(err), kind: 'err' });
    } finally {
      setBusy(false);
    }
  }

  async function signInQuick() {
    setBusy(true);
    quickCancel.current = false;
    setStatus({ text: 'Starting Quick Connect…', kind: 'info' });
    try {
      const url = await checkServer();
      if (!url) return;
      const devId = deviceId();
      const init = await call<{ Secret: string; Code: string }>(url, '/QuickConnect/Initiate', devId, {
        method: 'POST',
      }).catch(() => {
        throw new Error('Quick Connect is turned off on this server. Use your password instead.');
      });
      setQuickCode(init.Code);
      setStatus({
        text: 'In Jellyfin on another device, open your profile, then Quick Connect, and enter this code.',
        kind: 'info',
      });
      const deadline = Date.now() + 5 * 60_000;
      while (!quickCancel.current && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2500));
        const st = await call<{ Authenticated: boolean }>(
          url,
          `/QuickConnect/Connect?secret=${encodeURIComponent(init.Secret)}`,
          devId,
        );
        if (st?.Authenticated) {
          const auth = await call<AuthResult>(url, '/Users/AuthenticateWithQuickConnect', devId, {
            body: { Secret: init.Secret },
          });
          setQuickCode(null);
          await finish(url, auth, devId);
          return;
        }
      }
      if (!quickCancel.current) setStatus({ text: 'The code expired. Try again.', kind: 'err' });
      setQuickCode(null);
    } catch (err) {
      setQuickCode(null);
      setStatus({ text: err instanceof Error ? err.message : String(err), kind: 'err' });
    } finally {
      setBusy(false);
    }
  }

  async function signInApiKey(e: Event) {
    e.preventDefault();
    setBusy(true);
    setStatus({ text: 'Checking the API key…', kind: 'info' });
    try {
      const url = await checkServer();
      if (!url) return;
      const devId = deviceId();
      const key = apiKey.trim();
      const users = await call<{ Id: string; Name: string }[]>(url, '/Users', devId, { token: key });
      const user = users.find(u => u.Name.toLowerCase() === username.trim().toLowerCase());
      if (!user) throw new Error(`No user named "${username.trim()}" on this server.`);
      await finish(url, { AccessToken: key, User: user }, devId);
      setApiKey('');
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : String(err), kind: 'err' });
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      if (values.server_url && values.access_token) {
        await call(values.server_url, '/Sessions/Logout', values.device_id || 'x', {
          method: 'POST',
          token: values.access_token,
        }).catch(() => {});
      }
      await save({ access_token: '', user_id: '' });
      setStatus({ text: 'Signed out.', kind: 'info' });
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <main><p class="hint">Loading…</p></main>;

  return (
    <main>
      <header class="brand">
        <img src={ICON} alt="" width={44} height={44} />
        <div>
          <h1>{ctx?.name ?? APP_NAME}</h1>
          <p class="hint">Jellyfin remote for your Car Thing · v{ctx?.version ?? APP_VERSION}</p>
        </div>
      </header>

      {signedIn ? (
        <section class="card ok">
          <strong>Signed in as {values.username || 'your account'}</strong>
          <p class="hint url">{values.server_url}</p>
          <div class="row">
            <button type="button" class="secondary" disabled={busy} onClick={signOut}>
              Sign out
            </button>
            <button type="button" onClick={() => settings.done()}>
              Done
            </button>
          </div>
        </section>
      ) : null}

      <section class="card">
        <div class="field">
          <label for="server">Server address</label>
          <input
            id="server"
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="http://192.168.1.20:8096"
            value={server}
            onInput={e => {
              setServer((e.target as HTMLInputElement).value);
              setServerInfo(null);
            }}
          />
          {serverInfo ? <span class="good">✓ {serverInfo}</span> : null}
        </div>
        <button type="button" class="secondary small" disabled={busy} onClick={() => void checkServer()}>
          Test connection
        </button>
        <p class="hint">
          Your phone carries all of the Car Thing's traffic, so use an address your phone can reach: your home
          network address, or a public HTTPS address if you want it on the road.
        </p>
      </section>

      <div class="tabs">
        {(
          [
            ['password', 'Password'],
            ['quick', 'Quick Connect'],
            ['apikey', 'API key'],
          ] as [Mode, string][]
        ).map(([m, label]) => (
          <button type="button" key={m} class={mode === m ? 'tab on' : 'tab'} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>

      {mode === 'password' ? (
        <form class="card" onSubmit={signInPassword}>
          <div class="field">
            <label for="user">Username</label>
            <input
              id="user"
              autoCapitalize="off"
              autoCorrect="off"
              value={username}
              onInput={e => setUsername((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="field">
            <label for="pw">Password</label>
            <input id="pw" type="password" value={password} onInput={e => setPassword((e.target as HTMLInputElement).value)} />
          </div>
          <button type="submit" disabled={busy || !username.trim()}>
            {signedIn ? 'Sign in again' : 'Sign in'}
          </button>
          <p class="hint">Only the access token is saved, never your password.</p>
        </form>
      ) : null}

      {mode === 'quick' ? (
        <section class="card">
          {quickCode ? (
            <div class="code">{quickCode}</div>
          ) : (
            <p class="hint">Sign in without typing a password. You approve the code from any device already signed in.</p>
          )}
          <div class="row">
            <button type="button" disabled={busy} onClick={() => void signInQuick()}>
              {quickCode ? 'Waiting for approval…' : 'Get a code'}
            </button>
            {quickCode ? (
              <button
                type="button"
                class="secondary"
                onClick={() => {
                  quickCancel.current = true;
                  setQuickCode(null);
                  setStatus(null);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {mode === 'apikey' ? (
        <form class="card" onSubmit={signInApiKey}>
          <div class="field">
            <label for="key">API key</label>
            <input
              id="key"
              type="password"
              autoCapitalize="off"
              value={apiKey}
              onInput={e => setApiKey((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="field">
            <label for="user2">Play as user</label>
            <input
              id="user2"
              autoCapitalize="off"
              autoCorrect="off"
              value={username}
              onInput={e => setUsername((e.target as HTMLInputElement).value)}
            />
          </div>
          <button type="submit" disabled={busy || !apiKey.trim() || !username.trim()}>
            Save API key
          </button>
          <p class="hint">Create one in Jellyfin's Dashboard, under API Keys. Admins only.</p>
        </form>
      ) : null}

      {status ? <p class={`status ${status.kind}`}>{status.text}</p> : null}

      {/* 1.4.4: display options (live: the Car Thing reads config changes as they happen) */}
      <section class="card">
        <label class="toggle">
          <div>
            <div class="t">Hide tab bar until a preset button is pressed</div>
            <div class="s">The tabs show for a moment when you press 1–4, then fade away. Turn off to keep them on screen.</div>
          </div>
          <input
            type="checkbox"
            checked={values.tabs_autohide !== 'false'}
            onChange={e => void save({ tabs_autohide: (e.target as HTMLInputElement).checked ? 'true' : 'false' })}
          />
        </label>
      </section>

      <section class="help">
        <h2>On the Car Thing</h2>
        <ul>
          <li><b>1</b> Home · <b>2</b> Playlists · <b>3</b> Albums · <b>4</b> Library</li>
          <li>The tab bar appears when you press a preset button, then fades (unless you turn hiding off above)</li>
          <li>Hold <b>1</b> for Now Playing, <b>3</b> to pick the player, <b>4</b> to favorite the song</li>
          <li><b>Knob</b> scrolls lists, and turns this phone's volume on Now Playing (hold it to turn the volume anywhere); the phone shows its own volume overlay</li>
          <li><b>Knob press</b> opens the highlighted item, or plays/pauses on Now Playing · <b>Back</b> goes back</li>
          <li>Music plays on a Jellyfin player you choose: Finamp or the Jellyfin app on this phone, a TV, or a computer.</li>
        </ul>
      </section>
    </main>
  );
}

const ICON = LOGO_URL;

render(<Settings />, document.getElementById('root')!);
