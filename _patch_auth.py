"""
Parcha docs/index.html para agregar login/registro multi-tenant completo.
"""
import sys, re

PATH = 'docs/index.html'

with open(PATH, 'r', encoding='utf-8') as f:
    html = f.read()

# ── 1. _session + apiFetch justo después de createClient ──────────────────
OLD1 = 'const db = createClient(SUPABASE_URL, SUPABASE_KEY);'
NEW1 = '''const db = createClient(SUPABASE_URL, SUPABASE_KEY);

let _session = null;
function apiFetch(url, opts = {}) {
  const h = _session ? { 'Authorization': `Bearer ${_session.access_token}` } : {};
  return fetch(url, { ...opts, headers: { ...h, ...(opts.headers || {}) } });
}'''
assert OLD1 in html, 'FALLO: no se encontro createClient'
html = html.replace(OLD1, NEW1, 1)

# ── 2. LoginScreen (antes de // ── App ──) ────────────────────────────────
LOGIN_SCREEN = '''// ── Auth ──
function LoginScreen({ onLogin }) {
  const [mode, setMode]               = useState('login');
  const [email, setEmail]             = useState('');
  const [password, setPassword]       = useState('');
  const [nombreEstudio, setNombre]    = useState('');
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');

  async function handleLogin(e) {
    e.preventDefault(); setLoading(true); setError('');
    const { data, error: err } = await db.auth.signInWithPassword({ email, password });
    if (err) { setError(err.message); setLoading(false); return; }
    onLogin(data.session);
  }

  async function handleRegister(e) {
    e.preventDefault();
    if (!nombreEstudio.trim()) { setError('Ingresá el nombre del estudio.'); return; }
    setLoading(true); setError('');
    const { error: err } = await db.auth.signUp({
      email, password,
      options: { data: { nombre_estudio: nombreEstudio.trim() } }
    });
    if (err) { setError(err.message); setLoading(false); return; }
    setMode('verify'); setLoading(false);
  }

  const wrap = {
    minHeight: '100vh', background: '#F0F2F7',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: "'DM Sans',sans-serif"
  };
  const card = {
    background: '#fff', borderRadius: '16px', padding: '40px',
    maxWidth: '420px', width: '90%',
    boxShadow: '0 4px 32px rgba(27,45,79,0.10)'
  };
  const labelStyle = {
    display: 'block', fontSize: '12px', fontWeight: '600',
    color: '#6B7A96', marginBottom: '6px',
    letterSpacing: '0.06em', textTransform: 'uppercase'
  };
  const inputStyle = {
    width: '100%', padding: '11px 14px',
    border: '1.5px solid #DDE3EE', borderRadius: '10px',
    fontSize: '14px', fontFamily: 'inherit', outline: 'none',
    boxSizing: 'border-box'
  };
  function Field({ label, type = 'text', value, onChange, placeholder, required, minLength }) {
    const [focus, setFocus] = React.useState(false);
    return (
      <div style={{ marginBottom: '14px' }}>
        <label style={labelStyle}>{label}</label>
        <input
          type={type} value={value} onChange={onChange}
          placeholder={placeholder} required={required}
          minLength={minLength}
          style={{ ...inputStyle, borderColor: focus ? '#2BAF82' : '#DDE3EE' }}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        />
      </div>
    );
  }

  if (mode === 'verify') return (
    <div style={wrap}>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: '44px', marginBottom: '16px' }}>📧</div>
        <div style={{ fontSize: '18px', fontWeight: '700', color: '#1B2D4F', marginBottom: '10px' }}>
          Revisá tu email
        </div>
        <div style={{ fontSize: '14px', color: '#6B7A96', lineHeight: '1.65' }}>
          Te enviamos un link de confirmación a{' '}
          <strong style={{ color: '#1B2D4F' }}>{email}</strong>.
          <br/>Hacé clic en el link para activar tu cuenta.
        </div>
        <button
          onClick={() => { setMode('login'); setError(''); }}
          style={{ marginTop: '24px', background: '#1B2D4F', color: '#fff', border: 'none', borderRadius: '10px', padding: '12px 32px', fontFamily: 'inherit', fontWeight: '600', cursor: 'pointer', fontSize: '14px' }}
        >
          Ya confirmé → Iniciar sesión
        </button>
      </div>
    </div>
  );

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ marginBottom: '28px' }}>
          <div style={{ fontSize: '20px', fontWeight: '700', color: '#2BAF82', letterSpacing: '0.04em' }}>AXENDA</div>
          <div style={{ fontSize: '10px', color: '#5D8AB0', letterSpacing: '0.14em', textTransform: 'uppercase' }}>CONTABLE</div>
          <div style={{ fontSize: '18px', fontWeight: '600', color: '#1B2D4F', marginTop: '18px' }}>
            {mode === 'login' ? 'Iniciar sesión' : 'Crear tu estudio'}
          </div>
          {mode === 'register' && (
            <div style={{ fontSize: '13px', color: '#6B7A96', marginTop: '4px' }}>
              Creá tu cuenta para empezar
            </div>
          )}
        </div>

        <form onSubmit={mode === 'login' ? handleLogin : handleRegister}>
          {mode === 'register' && (
            <Field
              label="Nombre del estudio"
              value={nombreEstudio}
              onChange={e => setNombre(e.target.value)}
              placeholder="Ej. Estudio Contable López"
              required
            />
          )}
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="hola@estudio.com"
            required
          />
          <div style={{ marginBottom: '22px' }}>
            <Field
              label="Contraseña"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Mínimo 6 caracteres"
              required
              minLength={6}
            />
          </div>

          {error && (
            <div style={{ background: '#E0454514', border: '1px solid #E0454530', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#E04545', marginBottom: '14px' }}>
              {error}
            </div>
          )}

          <button
            type="submit" disabled={loading}
            style={{ width: '100%', background: loading ? '#A0AEC0' : '#2BAF82', color: '#fff', border: 'none', borderRadius: '10px', padding: '13px', fontFamily: 'inherit', fontWeight: '700', cursor: loading ? 'default' : 'pointer', fontSize: '14px', transition: 'background 0.15s' }}
          >
            {loading ? 'Procesando...' : mode === 'login' ? 'Ingresar' : 'Crear cuenta'}
          </button>
        </form>

        <div style={{ marginTop: '20px', textAlign: 'center', fontSize: '13px', color: '#6B7A96' }}>
          {mode === 'login' ? (
            <>¿Primera vez?{' '}
              <button onClick={() => { setMode('register'); setError(''); }} style={{ background: 'none', border: 'none', color: '#2BAF82', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px' }}>
                Crear cuenta
              </button>
            </>
          ) : (
            <>¿Ya tenés cuenta?{' '}
              <button onClick={() => { setMode('login'); setError(''); }} style={{ background: 'none', border: 'none', color: '#2BAF82', fontWeight: '600', cursor: 'pointer', fontFamily: 'inherit', fontSize: '13px' }}>
                Iniciar sesión
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

'''

OLD2 = '// ── App ──'
assert OLD2 in html, 'FALLO: no se encontro marcador App'
html = html.replace(OLD2, LOGIN_SCREEN + OLD2, 1)

# ── 3. Session state + auth listener + logout en App() ───────────────────
OLD3 = '''  const [clienteDetalle,setClienteDetalle] = useState(null);
  const fileInputRef  = useRef(null);
  const importSlugRef = useRef(null);
  const dias = diasAlCorte();'''

NEW3 = '''  const [clienteDetalle,setClienteDetalle] = useState(null);
  const fileInputRef  = useRef(null);
  const importSlugRef = useRef(null);
  const dias = diasAlCorte();
  const [session,setSession]           = useState(null);
  const [authLoading,setAuthLoading]   = useState(true);
  useEffect(()=>{
    db.auth.getSession().then(({data:{session:s}})=>{ _session=s; setSession(s); setAuthLoading(false); });
    const {data:{subscription}} = db.auth.onAuthStateChange((_ev,s)=>{ _session=s; setSession(s); });
    return ()=>subscription.unsubscribe();
  },[]);
  async function logout(){ await db.auth.signOut(); _session=null; setSession(null); }'''

assert OLD3 in html, 'FALLO: no se encontro bloque de state'
html = html.replace(OLD3, NEW3, 1)

# ── 4. cargarDatos useEffect: ejecutar solo cuando hay sesión ─────────────
OLD4 = '  useEffect(()=>{cargarDatos();},[]);'
NEW4 = '  useEffect(()=>{ if(session) cargarDatos(); },[session]);'
assert OLD4 in html, 'FALLO: no se encontro cargarDatos useEffect'
html = html.replace(OLD4, NEW4, 1)

# ── 5. Early returns antes del return principal ───────────────────────────
OLD5 = '  return ('
NEW5 = '''  if(authLoading) return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#F0F2F7",fontSize:"14px",color:"#6B7A96"}}>
      Cargando...
    </div>
  );
  if(!session) return <LoginScreen onLogin={s=>{ _session=s; setSession(s); }}/>;

  return ('''

# Solo reemplaza la PRIMERA ocurrencia (el return principal de App)
idx = html.rfind('  return (', 0, html.find('ReactDOM.render'))
assert idx >= 0, 'FALLO: no se encontro return principal de App'
html = html[:idx] + NEW5 + html[idx + len(OLD5):]

# ── 6. Sidebar footer: email + logout ─────────────────────────────────────
OLD6 = '''        <div className="sidebar-footer">
          <div className="footer-text">axendacontable@gmail.com</div>
        </div>'''
NEW6 = '''        <div className="sidebar-footer">
          <div className="footer-text" style={{marginBottom:"8px"}}>{session?.user?.email}</div>
          <button onClick={logout} style={{width:"100%",background:"none",border:"1px solid #2F4875",borderRadius:"8px",padding:"8px",fontFamily:"inherit",fontSize:"12px",color:"#8CA0BE",cursor:"pointer",fontWeight:"500"}}>Cerrar sesión</button>
        </div>'''
assert OLD6 in html, 'FALLO: no se encontro sidebar-footer'
html = html.replace(OLD6, NEW6, 1)

# ── 7. Reemplazar todos los fetch(BACKEND_URL) por apiFetch ───────────────
before = html.count('fetch(`${BACKEND_URL}')
html = html.replace('fetch(`${BACKEND_URL}', 'apiFetch(`${BACKEND_URL}')
after = html.count('fetch(`${BACKEND_URL}')

with open(PATH, 'w', encoding='utf-8') as f:
    f.write(html)

print(f'OK: _session + apiFetch agregados')
print(f'OK: LoginScreen insertado')
print(f'OK: session state + auth listener + logout en App()')
print(f'OK: cargarDatos useEffect actualizado')
print(f'OK: early returns agregados')
print(f'OK: sidebar footer actualizado')
print(f'OK: fetch->apiFetch reemplazados: {before} -> {after} restantes')
