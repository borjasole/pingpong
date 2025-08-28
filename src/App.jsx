import React, { useEffect, useMemo, useState } from "react";

// ============================
// Torneo de Ping Pong — React + Firebase (Google Login)
// - Registro de usuarios y perfiles
// - Liga todos contra todos con ranking dinámico
// - Eliminatorias (Octavos/Cuartos/Semifinal/Final)
// - Calendario (liga y playoffs)
// - Panel admin (rol por email) para gestionar resultados y calendario
// - Persistencia en Firestore + tiempo real (onSnapshot)
// - Login con Google (Firebase Auth)
// - Export/Import JSON (opcional)
// - UI responsive con TailwindCSS
// ============================

// ============================
// 🔧 CONFIGURACIÓN FIREBASE
// 1) Crea un proyecto en https://console.firebase.google.com
// 2) Habilita Authentication > Sign-in method > Google
// 3) Crea una base de datos Firestore en modo production/test
// 4) Copia tu config aquí:
// ============================
const firebaseConfig = {
  apiKey: "AIzaSyCSVdOkHsJUGRGhriUOBvXCIJrUpGjMb-w",
  authDomain: "murphypingpong.firebaseapp.com",
  projectId: "murphypingpong",
  storageBucket: "murphypingpong.firebasestorage.app",
  messagingSenderId: "347416591858",
  appId: "1:347416591858:web:73dcbbb553a60c8e9d7f6b",
  measurementId: "G-EGS9DCN3TR"
};

// **Emails administradores** (puedes cambiarlo a control por colección si prefieres)
const ADMIN_EMAILS = [
  "admin@tu-dominio.com",
];

// SDK Firebase (v9+ modular)
import { initializeApp, getApps } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut,
} from "firebase/auth";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  onSnapshot,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  writeBatch,
  query,
  orderBy,
} from "firebase/firestore";

// Inicializar Firebase una sola vez
let app;
if (!getApps().length) app = initializeApp(firebaseConfig);
else app = getApps()[0];
const auth = getAuth(app);
const db = getFirestore(app);

// ============================
// Tipos (JSDoc para claridad)
/** @typedef {{ id: string; nombre: string; email?: string; creadoEl: string; avatarHue: number; uid?: string }} Player */
/** @typedef {{ l: number; v: number }} Resultado */
/** @typedef {"Programado"|"En juego"|"Finalizado"} Estado */
/** @typedef {"Liga"|"Eliminatorias"} Fase */
/** @typedef {"Octavos"|"Cuartos"|"Semifinal"|"Final"} Ronda */

// Participant Refs para eliminatorias
/** @typedef {{ type: 'player'; id: string }} PRPlayer */
/** @typedef {{ type: 'seed'; seed: number }} PRSeed */
/** @typedef {{ type: 'winner'; matchId: string }} PRWinner */
/** @typedef {PRPlayer|PRSeed|PRWinner} ParticipantRef */

/** @typedef {{
 *   id: string;
 *   fase: Fase;
 *   ronda?: Ronda;
 *   localId?: string;
 *   visitanteId?: string;
 *   localRef?: ParticipantRef;
 *   visitanteRef?: ParticipantRef;
 *   fechaISO: string;
 *   lugar?: string;
 *   resultado?: Resultado|null;
 *   estado: Estado;
 *   createdAt?: any;
 * }} Match */

// Utilidad para IDs únicos
const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2));
const hue = () => Math.floor(Math.random() * 360);

// Fecha utilidades
const addMinutes = (date, mins) => new Date(date.getTime() + mins * 60000);
const toLocal = (iso) => new Date(iso);
const fmtDate = (iso) => toLocal(iso).toLocaleDateString("es-ES", { weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtTime = (iso) => toLocal(iso).toLocaleTimeString("es-ES", { hour: '2-digit', minute: '2-digit' });

// Ranking y estadísticas
function computeStandings(players, matches) {
  const stats = new Map();
  players.forEach(p => stats.set(p.id, {
    jugador: p,
    pj: 0, pg: 0, pp: 0,
    gf: 0, gc: 0, dif: 0,
    pts: 0,
  }));

  matches.filter(m => m.fase === 'Liga' && m.resultado && m.estado === 'Finalizado').forEach(m => {
    const a = stats.get(m.localId);
    const b = stats.get(m.visitanteId);
    if (!a || !b) return;
    a.pj += 1; b.pj += 1;
    a.gf += m.resultado.l; a.gc += m.resultado.v;
    b.gf += m.resultado.v; b.gc += m.resultado.l;
    if (m.resultado.l > m.resultado.v) { a.pg += 1; b.pp += 1; a.pts += 3; }
    else if (m.resultado.l < m.resultado.v) { b.pg += 1; a.pp += 1; b.pts += 3; }
    else { a.pts += 1; b.pts += 1; }
  });

  for (const s of stats.values()) s.dif = s.gf - s.gc;

  const table = Array.from(stats.values()).sort((x, y) => {
    if (y.pts !== x.pts) return y.pts - x.pts;
    if (y.dif !== x.dif) return y.dif - x.dif;
    if (y.gf !== x.gf) return y.gf - x.gf;
    return x.jugador.nombre.localeCompare(y.jugador.nombre, 'es');
  }).map((row, idx) => ({ pos: idx + 1, ...row }));

  return table;
}

// Emparejamientos round-robin (liga)
function roundRobinPairs(playerIds) {
  const ids = [...playerIds];
  if (ids.length % 2 === 1) ids.push("BYE");
  const n = ids.length;
  const rounds = n - 1;
  const schedule = [];
  for (let r = 0; r < rounds; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = ids[i];
      const b = ids[n - 1 - i];
      if (a !== "BYE" && b !== "BYE") pairs.push([a, b]);
    }
    schedule.push(pairs);
    const fixed = ids[0];
    const rest = ids.slice(1);
    rest.unshift(rest.pop());
    ids.splice(0, ids.length, fixed, ...rest);
  }
  return schedule;
}

// Helpers de UI
const Section = ({ title, children, right }) => (
  <div className="mb-8">
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-xl md:text-2xl font-semibold">{title}</h2>
      {right}
    </div>
    <div className="bg-white/70 dark:bg-zinc-900/60 rounded-2xl shadow-sm border border-zinc-200 dark:border-zinc-800 p-4 md:p-6">{children}</div>
  </div>
);

const Pill = ({ children }) => <span className="text-xs px-2 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700">{children}</span>;

function Avatar({ name, hue }) {
  const initials = name.split(" ").map(w => w[0]?.toUpperCase()).slice(0,2).join("") || "?";
  return (
    <div className="w-8 h-8 rounded-full grid place-items-center text-white text-xs font-bold" style={{ background: `hsl(${hue} 70% 45%)` }}>
      {initials}
    </div>
  );
}

function ScoreBadge({ r }) {
  if (!r) return <Pill>—</Pill>;
  return <span className="text-sm font-semibold">{r.l} - {r.v}</span>;
}

// ============================
// 🔌 Estado con Firestore + Auth
// ============================
function useFirebaseState() {
  const [user, setUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [players, setPlayers] = useState/** @type {Player[]} */([]);
  const [matches, setMatches] = useState/** @type {Match[]} */([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAdmin(!!u && ADMIN_EMAILS.includes(u.email || ""));
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    // Suscripción en tiempo real
    const unsubPlayers = onSnapshot(query(collection(db, "players"), orderBy("nombre")), (snap) => {
      const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setPlayers(arr);
    });
    const unsubMatches = onSnapshot(query(collection(db, "matches"), orderBy("fechaISO")), (snap) => {
      const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setMatches(arr);
      setLoading(false);
    });
    return () => { unsubPlayers(); unsubMatches(); };
  }, []);

  // ---- Mutaciones ----
  const createPlayer = async ({ nombre, email }) => {
    const p = { nombre, email: email || "", creadoEl: new Date().toISOString(), avatarHue: hue(), uid: user?.uid || null };
    await addDoc(collection(db, "players"), p);
  };
  const updatePlayerName = async (id, nombre) => {
    await updateDoc(doc(db, "players", id), { nombre });
  };
  const deletePlayer = async (id) => {
    await deleteDoc(doc(db, "players", id));
  };

  const createMatch = async (m /** @type {Match} */) => {
    await setDoc(doc(db, "matches", m.id), { ...m, createdAt: serverTimestamp() });
  };
  const updateMatchScore = async (id, l, v) => {
    await updateDoc(doc(db, "matches", id), { resultado: { l, v }, estado: 'Finalizado' });
  };
  const updateMatchDate = async (id, fechaISO) => {
    await updateDoc(doc(db, "matches", id), { fechaISO });
  };
  const deleteAllData = async () => {
    const b = writeBatch(db);
    const ps = await getDocs(collection(db, "players"));
    ps.forEach(d => b.delete(d.ref));
    const ms = await getDocs(collection(db, "matches"));
    ms.forEach(d => b.delete(d.ref));
    await b.commit();
  };

  return { user, isAdmin, players, matches, loading, createPlayer, updatePlayerName, deletePlayer, createMatch, updateMatchScore, updateMatchDate, deleteAllData };
}

// Resuelve un ParticipantRef a playerId
function resolveParticipant(ref, standings, matches) {
  if (!ref) return null;
  if (ref.type === 'player') return ref.id;
  if (ref.type === 'seed') {
    const row = standings.find(s => s.pos === ref.seed);
    return row?.jugador.id ?? null;
  }
  if (ref.type === 'winner') {
    const m = matches.find(x => x.id === ref.matchId);
    if (!m || !m.resultado) return null;
    const lId = m.localRef ? resolveParticipant(m.localRef, standings, matches) : m.localId;
    const vId = m.visitanteRef ? resolveParticipant(m.visitanteRef, standings, matches) : m.visitanteId;
    if (!lId || !vId) return null;
    return m.resultado.l > m.resultado.v ? lId : (m.resultado.l < m.resultado.v ? vId : null);
  }
  return null;
}

function seedPairsForSize(size) {
  if (size === 16) return [[1,16],[8,9],[5,12],[4,13],[3,14],[6,11],[7,10],[2,15]];
  if (size === 8) return [[1,8],[4,5],[3,6],[2,7]];
  if (size === 4) return [[1,4],[2,3]];
  if (size === 2) return [[1,2]];
  return [];
}

function nextRoundLabel(ronda) {
  if (ronda === 'Octavos') return 'Cuartos';
  if (ronda === 'Cuartos') return 'Semifinal';
  if (ronda === 'Semifinal') return 'Final';
  return null;
}

export default function TorneoPingPongApp() {
  const {
    user, isAdmin,
    players, matches, loading,
    createPlayer, updatePlayerName, deletePlayer,
    createMatch, updateMatchScore, updateMatchDate, deleteAllData,
  } = useFirebaseState();

  const standings = useMemo(() => computeStandings(players, matches), [players, matches]);
  const [tab, setTab] = useState(/** @type {"registro"|"clasificacion"|"calendario"|"eliminatorias"|"admin"} */("registro"));
  const [form, setForm] = useState({ nombre: "", email: "" });
  const canRegister = form.nombre.trim().length >= 2;

  const registerPlayer = async () => {
    if (!canRegister) return;
    await createPlayer({ nombre: form.nombre.trim(), email: form.email.trim() });
    setForm({ nombre: "", email: "" });
    setTab("clasificacion");
  };

  // Auth handlers
  const doGoogleLogin = async () => {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  };
  const doLogout = async () => { await signOut(auth); };

  // Crear/editar resultados
  async function setMatchScore(matchId, l, v) { await updateMatchScore(matchId, l, v); }

  // Crear partido manual
  const [newMatch, setNewMatch] = useState({ fase: /** @type {Fase} */('Liga'), ronda: /** @type {Ronda|''} */(''), localId: '', visitanteId: '', fecha: new Date().toISOString(), lugar: '' });
  const createManualMatch = async () => {
    if (newMatch.fase === 'Liga') {
      if (!newMatch.localId || !newMatch.visitanteId || newMatch.localId === newMatch.visitanteId) return;
      const nm = /** @type {Match} */({ id: uid(), fase: 'Liga', localId: newMatch.localId, visitanteId: newMatch.visitanteId, fechaISO: newMatch.fecha, lugar: newMatch.lugar || undefined, resultado: null, estado: 'Programado' });
      await createMatch(nm);
    } else {
      if (!newMatch.localId || !newMatch.visitanteId || newMatch.localId === newMatch.visitanteId) return;
      const nm = /** @type {Match} */({ id: uid(), fase: 'Eliminatorias', ronda: /** @type {Ronda} */(newMatch.ronda || 'Cuartos'), localRef: { type: 'player', id: newMatch.localId }, visitanteRef: { type: 'player', id: newMatch.visitanteId }, fechaISO: newMatch.fecha, lugar: newMatch.lugar || undefined, resultado: null, estado: 'Programado' });
      await createMatch(nm);
    }
  };

  // Generar calendario de liga (round-robin)
  async function generarLiga() {
    const ids = players.map(p => p.id);
    const rr = roundRobinPairs(ids);
    const start = new Date(); start.setHours(18,0,0,0);
    let cursor = new Date(start);
    for (let roundIdx = 0; roundIdx < rr.length; roundIdx++) {
      const pairs = rr[roundIdx];
      for (let i = 0; i < pairs.length; i++) {
        const [a,b] = pairs[i];
        const fecha = addMinutes(cursor, (roundIdx * 60) + (i * 45));
        const m = /** @type {Match} */({ id: uid(), fase: 'Liga', localId: a, visitanteId: b, fechaISO: fecha.toISOString(), estado: 'Programado', resultado: null });
        await createMatch(m);
      }
    }
    setTab('calendario');
  }

  // Generar cuadro de eliminatorias a partir de clasificación
  async function generarEliminatorias() {
    const num = players.length >= 16 ? 16 : (players.length >= 8 ? 8 : (players.length >= 4 ? 4 : 2));
    const pares = seedPairsForSize(num);
    if (pares.length === 0) return;

    const ahora = new Date(); ahora.setHours(19, 0, 0, 0);
    let rondaInicial = /** @type {Ronda} */(num === 16 ? 'Octavos' : (num === 8 ? 'Cuartos' : (num === 4 ? 'Semifinal' : 'Final')));

    /** @type {Match[]} */
    const nuevos = [];
    pares.forEach((pair, idx) => {
      const [s1, s2] = pair;
      const fecha = addMinutes(ahora, idx * 50);
      const m = /** @type {Match} */({ id: uid(), fase: 'Eliminatorias', ronda: rondaInicial, localRef: { type: 'seed', seed: s1 }, visitanteRef: { type: 'seed', seed: s2 }, fechaISO: fecha.toISOString(), estado: 'Programado', resultado: null });
      nuevos.push(m);
    });

    let currentRonda = rondaInicial;
    while (true) {
      const next = nextRoundLabel(currentRonda);
      if (!next) break;
      const prevMatches = nuevos.filter(m => m.ronda === currentRonda);
      for (let i = 0; i < prevMatches.length; i += 2) {
        const a = prevMatches[i];
        const b = prevMatches[i+1];
        const fecha = addMinutes(ahora, (nuevos.length) * 50);
        const nm = /** @type {Match} */({ id: uid(), fase: 'Eliminatorias', ronda: /** @type {Ronda} */(next), localRef: { type: 'winner', matchId: a.id }, visitanteRef: { type: 'winner', matchId: b.id }, fechaISO: fecha.toISOString(), estado: 'Programado', resultado: null });
        nuevos.push(nm);
      }
      currentRonda = /** @type {Ronda} */(next);
    }

    // Borra eliminatorias anteriores y crea nuevas de golpe
    const existing = matches.filter(m => m.fase === 'Eliminatorias');
    const batch = writeBatch(db);
    existing.forEach(m => batch.delete(doc(db, "matches", m.id)));
    nuevos.forEach(m => batch.set(doc(db, "matches", m.id), { ...m, createdAt: serverTimestamp() }));
    await batch.commit();

    setTab('eliminatorias');
  }

  // Utilidades de UI
  const leagueMatches = matches.filter(m => m.fase === 'Liga').sort((a,b) => a.fechaISO.localeCompare(b.fechaISO));
  const playoffMatches = matches.filter(m => m.fase === 'Eliminatorias');

  function groupByDay(ms) {
    const map = new Map();
    ms.forEach(m => {
      const d = fmtDate(m.fechaISO);
      if (!map.has(d)) map.set(d, []);
      map.get(d).push(m);
    });
    for (const arr of map.values()) arr.sort((a,b) => a.fechaISO.localeCompare(b.fechaISO));
    return Array.from(map.entries());
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-zinc-100 dark:from-zinc-950 dark:to-zinc-900 text-zinc-900 dark:text-zinc-100">
      <div className="max-w-6xl mx-auto px-4 py-6 md:py-10">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl md:text-4xl font-extrabold tracking-tight">Torneo de Ping Pong</h1>
            <p className="text-sm md:text-base text-zinc-600 dark:text-zinc-400">Organiza tu liga, cuadro de eliminatorias y calendario en tiempo real.</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={()=>setTab('registro')} className={`px-3 py-2 rounded-xl border ${tab==='registro'?'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900':'bg-white/70 dark:bg-zinc-800'}`}>Registro</button>
            <button onClick={()=>setTab('clasificacion')} className={`px-3 py-2 rounded-xl border ${tab==='clasificacion'?'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900':'bg-white/70 dark:bg-zinc-800'}`}>Clasificación</button>
            <button onClick={()=>setTab('calendario')} className={`px-3 py-2 rounded-xl border ${tab==='calendario'?'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900':'bg-white/70 dark:bg-zinc-800'}`}>Calendario</button>
            <button onClick={()=>setTab('eliminatorias')} className={`px-3 py-2 rounded-xl border ${tab==='eliminatorias'?'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900':'bg-white/70 dark:bg-zinc-800'}`}>Eliminatorias</button>
            <button onClick={()=>setTab('admin')} className={`px-3 py-2 rounded-xl border ${tab==='admin'?'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900':'bg-white/70 dark:bg-zinc-800'}`}>Admin</button>
          </div>
        </header>

        {/* Barra de sesión */}
        <div className="mb-6 flex items-center justify-between gap-3">
          {user ? (
            <div className="flex items-center gap-3">
              <div className="text-sm">Conectado como <b>{user.displayName || user.email}</b></div>
              <button onClick={doLogout} className="px-3 py-2 rounded-xl border">Salir</button>
              {isAdmin && <Pill>Admin</Pill>}
            </div>
          ) : (
            <button onClick={doGoogleLogin} className="px-3 py-2 rounded-xl border bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">Acceder con Google</button>
          )}
        </div>

        {/* Registro y Perfil */}
        {tab === 'registro' && (
          <Section title="Registro y perfiles" right={<Pill>Jugadores: {players.length}</Pill>}>
            <div className="grid md:grid-cols-2 gap-6">
              <div>
                <h3 className="font-semibold mb-2">Crear nuevo perfil</h3>
                {!user && <div className="text-xs mb-2 text-zinc-500">Inicia sesión con Google para asociar tu perfil a tu cuenta.</div>}
                <div className="flex flex-col gap-3">
                  <input className="px-3 py-2 rounded-xl border bg-white/80 dark:bg-zinc-800" placeholder="Nombre y apellidos" value={form.nombre} onChange={e=>setForm(f=>({...f, nombre: e.target.value}))} />
                  <input className="px-3 py-2 rounded-xl border bg-white/80 dark:bg-zinc-800" placeholder="Email (opcional)" value={form.email} onChange={e=>setForm(f=>({...f, email: e.target.value}))} />
                  <button disabled={!canRegister} onClick={registerPlayer} className={`px-4 py-2 rounded-xl border font-semibold ${canRegister? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900':'opacity-50 bg-white/70 dark:bg-zinc-800'}`}>Crear perfil</button>
                </div>
              </div>
              <div>
                <h3 className="font-semibold mb-2">Jugadores registrados ({players.length})</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {players.map(p => (
                    <div key={p.id} className="flex items-center gap-3 p-3 rounded-xl border bg-white/60 dark:bg-zinc-800">
                      <Avatar name={p.nombre} hue={p.avatarHue} />
                      <div className="min-w-0">
                        <div className="font-medium truncate">{p.nombre}</div>
                        <div className="text-xs text-zinc-500 truncate">{p.email || '—'}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </Section>
        )}

        {/* Clasificación Liga */}
        {tab === 'clasificacion' && (
          <Section title="Clasificación — Liga" right={<button onClick={()=>setTab('calendario')} className="px-3 py-2 rounded-xl border bg-white/70 dark:bg-zinc-800">Ver calendario</button>}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-zinc-600 dark:text-zinc-400">
                  <tr>
                    <th className="py-2 px-2">#</th>
                    <th className="py-2 px-2">Jugador</th>
                    <th className="py-2 px-2">PJ</th>
                    <th className="py-2 px-2">PG</th>
                    <th className="py-2 px-2">PP</th>
                    <th className="py-2 px-2">GF</th>
                    <th className="py-2 px-2">GC</th>
                    <th className="py-2 px-2">Dif</th>
                    <th className="py-2 px-2">Pts</th>
                  </tr>
                </thead>
                <tbody>
                  {computeStandings(players, matches).map(row => (
                    <tr key={row.jugador.id} className="border-t border-zinc-200 dark:border-zinc-800">
                      <td className="py-2 px-2 w-10 text-center font-semibold">{row.pos}</td>
                      <td className="py-2 px-2">
                        <div className="flex items-center gap-2">
                          <Avatar name={row.jugador.nombre} hue={row.jugador.avatarHue} />
                          <span className="font-medium">{row.jugador.nombre}</span>
                        </div>
                      </td>
                      <td className="py-2 px-2">{row.pj}</td>
                      <td className="py-2 px-2">{row.pg}</td>
                      <td className="py-2 px-2">{row.pp}</td>
                      <td className="py-2 px-2">{row.gf}</td>
                      <td className="py-2 px-2">{row.gc}</td>
                      <td className="py-2 px-2">{row.dif}</td>
                      <td className="py-2 px-2 font-semibold">{row.pts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* Calendario */}
        {tab === 'calendario' && (
          <Section title="Calendario de partidos" right={<div className="flex gap-2"><Pill>Liga: {leagueMatches.length}</Pill><Pill>Eliminatorias: {playoffMatches.length}</Pill></div>}>
            {loading ? (
              <div className="text-sm text-zinc-500">Cargando…</div>
            ) : (
              <div className="grid md:grid-cols-2 gap-6">
                <div>
                  <h3 className="font-semibold mb-2">Liga</h3>
                  {groupByDay(leagueMatches).map(([dia, ms]) => (
                    <div key={dia} className="mb-4">
                      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">{dia}</div>
                      <div className="flex flex-col gap-2">
                        {ms.map(m => <MatchCard key={m.id} m={m} players={players} standings={standings} matches={matches} onScore={setMatchScore} onDate={updateMatchDate} admin={isAdmin} />)}
                      </div>
                    </div>
                  ))}
                  {leagueMatches.length === 0 && <div className="text-sm text-zinc-500">Aún no hay partidos de liga.</div>}
                </div>
                <div>
                  <h3 className="font-semibold mb-2">Eliminatorias</h3>
                  {groupByDay(playoffMatches).map(([dia, ms]) => (
                    <div key={dia} className="mb-4">
                      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">{dia}</div>
                      <div className="flex flex-col gap-2">
                        {ms.sort((a,b)=>a.fechaISO.localeCompare(b.fechaISO)).map(m => <MatchCard key={m.id} m={m} players={players} standings={standings} matches={matches} onScore={setMatchScore} onDate={updateMatchDate} admin={isAdmin} />)}
                      </div>
                    </div>
                  ))}
                  {playoffMatches.length === 0 && <div className="text-sm text-zinc-500">Aún no hay partidos de eliminatorias.</div>}
                </div>
              </div>
            )}
          </Section>
        )}

        {/* Eliminatorias — Cuadro */}
        {tab === 'eliminatorias' && (
          <Section title="Cuadro de eliminatorias" right={<button onClick={()=>setTab('calendario')} className="px-3 py-2 rounded-xl border bg-white/70 dark:bg-zinc-800">Ver fechas</button>}>
            <Bracket matches={playoffMatches} standings={standings} players={players} onScore={setMatchScore} admin={isAdmin} />
          </Section>
        )}

        {/* Admin */}
        {tab === 'admin' && (
          <Section title="Panel de administración" right={isAdmin? <Pill>Rol: Admin</Pill> : <Pill>Solo lectura</Pill>}>
            {!isAdmin ? (
              <div className="text-sm text-zinc-500">Debes iniciar sesión con un email autorizado para acceder como admin.</div>
            ) : (
              <div className="space-y-8">
                <div className="flex flex-wrap gap-2">
                  <button onClick={generarLiga} className="px-4 py-2 rounded-xl border bg-white/70 dark:bg-zinc-800">Generar liga (round robin)</button>
                  <button onClick={generarEliminatorias} className="px-4 py-2 rounded-xl border bg-white/70 dark:bg-zinc-800">Generar eliminatorias</button>
                  <button onClick={()=>{ if (confirm('¿Seguro que quieres borrar TODO?')) deleteAllData(); }} className="px-4 py-2 rounded-xl border bg-white/70 dark:bg-zinc-800">Borrar TODO</button>
                </div>

                <div className="grid md:grid-cols-2 gap-6">
                  <div>
                    <h3 className="font-semibold mb-2">Crear partido manual</h3>
                    <div className="flex flex-col gap-2">
                      <div className="flex gap-2 flex-wrap">
                        <select className="px-3 py-2 rounded-xl border bg-white/80 dark:bg-zinc-800" value={newMatch.fase} onChange={(e)=>setNewMatch(s=>({ ...s, fase: /** @type {Fase} */(e.target.value)}))}>
                          <option value="Liga">Liga</option>
                          <option value="Eliminatorias">Eliminatorias</option>
                        </select>
                        {newMatch.fase === 'Eliminatorias' && (
                          <select className="px-3 py-2 rounded-xl border bg-white/80 dark:bg-zinc-800" value={newMatch.ronda} onChange={(e)=>setNewMatch(s=>({ ...s, ronda: /** @type {Ronda|''} */(e.target.value)}))}>
                            <option value="Octavos">Octavos</option>
                            <option value="Cuartos">Cuartos</option>
                            <option value="Semifinal">Semifinal</option>
                            <option value="Final">Final</option>
                          </select>
                        )}
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        <select className="px-3 py-2 rounded-xl border bg-white/80 dark:bg-zinc-800" value={newMatch.localId} onChange={(e)=>setNewMatch(s=>({ ...s, localId: e.target.value }))}>
                          <option value="">Local…</option>
                          {players.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                        </select>
                        <select className="px-3 py-2 rounded-xl border bg-white/80 dark:bg-zinc-800" value={newMatch.visitanteId} onChange={(e)=>setNewMatch(s=>({ ...s, visitanteId: e.target.value }))}>
                          <option value="">Visitante…</option>
                          {players.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                        </select>
                      </div>
                      <div className="flex gap-2 flex-wrap items-center">
                        <input type="datetime-local" className="px-3 py-2 rounded-xl border bg-white/80 dark:bg-zinc-800" value={new Date(newMatch.fecha).toISOString().slice(0,16)} onChange={(e)=>setNewMatch(s=>({ ...s, fecha: new Date(e.target.value).toISOString() }))} />
                        <input className="px-3 py-2 rounded-xl border bg-white/80 dark:bg-zinc-800" placeholder="Lugar (opcional)" value={newMatch.lugar} onChange={(e)=>setNewMatch(s=>({ ...s, lugar: e.target.value }))} />
                        <button onClick={createManualMatch} className="px-4 py-2 rounded-xl border bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">Crear</button>
                      </div>
                    </div>
                  </div>
                  <div>
                    <h3 className="font-semibold mb-2">Gestionar jugadores</h3>
                    <div className="space-y-2">
                      {players.map(p => (
                        <div key={p.id} className="flex items-center gap-2 p-2 rounded-xl border bg-white/60 dark:bg-zinc-800">
                          <Avatar name={p.nombre} hue={p.avatarHue} />
                          <input className="flex-1 min-w-0 px-2 py-1 rounded-lg border bg-white/80 dark:bg-zinc-900" value={p.nombre} onChange={(e)=> updatePlayerName(p.id, e.target.value)} />
                          <button onClick={()=> deletePlayer(p.id)} className="px-3 py-1 rounded-lg border">Eliminar</button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="font-semibold mb-2">Partidos (editar resultados y calendario)</h3>
                  <div className="grid md:grid-cols-2 gap-3">
                    {matches.sort((a,b)=> a.fechaISO.localeCompare(b.fechaISO)).map(m => (
                      <MatchCard key={m.id} m={m} players={players} standings={standings} matches={matches} onScore={setMatchScore} onDate={updateMatchDate} admin={isAdmin} editable />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Section>
        )}

        <footer className="pt-6 text-xs text-zinc-500 text-center">
          Hecho con ❤️ · Datos en Firestore · Sesión con Google.
        </footer>
      </div>
    </div>
  );
}

function PlayerName({ id, players }) {
  const p = players.find(p => p.id === id);
  return p ? (
    <span className="inline-flex items-center gap-2"><Avatar name={p.nombre} hue={p.avatarHue} /><span className="truncate max-w-[12rem]">{p.nombre}</span></span>
  ) : <span>—</span>;
}

function MatchCard({ m, players, standings, matches, onScore, onDate, admin, editable=false }) {
  const localId = m.fase==='Liga' ? m.localId : resolveParticipant(m.localRef, standings, matches);
  const visId = m.fase==='Liga' ? m.visitanteId : resolveParticipant(m.visitanteRef, standings, matches);

  const [edit, setEdit] = useState(false);
  const [l, setL] = useState(m.resultado?.l ?? 0);
  const [v, setV] = useState(m.resultado?.v ?? 0);
  const canSave = Number.isFinite(l) && Number.isFinite(v);

  const [fecha, setFecha] = useState(m.fechaISO);

  useEffect(()=>{ setL(m.resultado?.l ?? 0); setV(m.resultado?.v ?? 0); setFecha(m.fechaISO); }, [m.id]);

  return (
    <div className="p-3 rounded-xl border bg-white/70 dark:bg-zinc-800">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-zinc-500 flex items-center gap-2 mb-1">
            <Pill>{m.fase}{m.ronda? ` · ${m.ronda}`: ''}</Pill>
            <span>{fmtDate(m.fechaISO)} · {fmtTime(m.fechaISO)}</span>
            {m.lugar && <span>· {m.lugar}</span>}
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0"><PlayerName id={localId} players={players} /></div>
            <ScoreBadge r={m.resultado} />
            <div className="flex-1 min-w-0 text-right"><PlayerName id={visId} players={players} /></div>
          </div>
        </div>
        {admin && (
          <div className="flex flex-col gap-2 items-end">
            <button onClick={()=>setEdit(e=>!e)} className="px-3 py-1 rounded-lg border text-xs">{edit? 'Cerrar':'Editar'}</button>
          </div>
        )}
      </div>

      {admin && edit && (
        <div className="mt-3 grid gap-2 text-sm">
          <div className="flex items-center gap-2">
            <label className="w-28 text-zinc-600">Resultado</label>
            <input type="number" className="px-2 py-1 rounded-lg border w-20" value={l} onChange={(e)=>setL(parseInt(e.target.value || '0',10))} />
            <span>-</span>
            <input type="number" className="px-2 py-1 rounded-lg border w-20" value={v} onChange={(e)=>setV(parseInt(e.target.value || '0',10))} />
            <button disabled={!canSave} onClick={()=>onScore(m.id, l, v)} className={`px-3 py-1 rounded-lg border ${canSave? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900':'opacity-50'}`}>Guardar</button>
          </div>
          <div className="flex items-center gap-2">
            <label className="w-28 text-zinc-600">Fecha/Hora</label>
            <input type="datetime-local" className="px-2 py-1 rounded-lg border" value={new Date(fecha).toISOString().slice(0,16)} onChange={(e)=>setFecha(new Date(e.target.value).toISOString())} />
            <button onClick={()=> onDate(m.id, fecha)} className="px-3 py-1 rounded-lg border">Guardar fecha</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Bracket({ matches, standings, players, onScore, admin }) {
  if (matches.length === 0) return <div className="text-sm text-zinc-500">Aún no hay eliminatorias generadas.</div>;

  /** @type {Ronda[]} */
  const order = ['Octavos','Cuartos','Semifinal','Final'];
  const cols = order.map(r => ({ ronda: r, ms: matches.filter(m => m.ronda === r).sort((a,b)=> a.fechaISO.localeCompare(b.fechaISO)) })).filter(c => c.ms.length > 0);

  return (
    <div className="overflow-x-auto">
      <div className="grid" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(220px, 1fr))`, gap: '1rem' }}>
        {cols.map((col) => (
          <div key={col.ronda} className="min-w-[220px]">
            <div className="text-sm font-semibold mb-2">{col.ronda}</div>
            <div className="flex flex-col gap-3">
              {col.ms.map(m => (
                <div key={m.id} className="p-3 rounded-xl border bg-white/70 dark:bg-zinc-800">
                  <div className="text-xs text-zinc-500 mb-1">{fmtDate(m.fechaISO)} · {fmtTime(m.fechaISO)}</div>
                  <MatchSide refx={m.localRef} standings={standings} players={players} matches={matches} />
                  <div className="text-center my-1 font-semibold">{m.resultado? `${m.resultado.l} - ${m.resultado.v}` : 'vs'}</div>
                  <MatchSide refx={m.visitanteRef} standings={standings} players={players} matches={matches} align="right" />
                  {admin && (
                    <div className="mt-2">
                      <InlineScoreEditor m={m} onScore={onScore} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MatchSide({ refx, standings, players, matches, align='left' }) {
  const pid = resolveParticipant(refx, standings, matches);
  return (
    <div className={`flex items-center gap-2 ${align==='right'?'justify-end':''}`}>
      {pid ? <PlayerName id={pid} players={players} /> : <span className="italic text-zinc-500">Por determinar</span>}
    </div>
  );
}

function InlineScoreEditor({ m, onScore }) {
  const [l, setL] = useState(m.resultado?.l ?? 0);
  const [v, setV] = useState(m.resultado?.v ?? 0);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span>Resultado:</span>
      <input type="number" className="px-2 py-1 rounded-lg border w-16" value={l} onChange={(e)=>setL(parseInt(e.target.value||'0',10))} />
      <span>-</span>
      <input type="number" className="px-2 py-1 rounded-lg border w-16" value={v} onChange={(e)=>setV(parseInt(e.target.value||'0',10))} />
      <button onClick={()=>onScore(m.id, l, v)} className="px-3 py-1 rounded-lg border">Guardar</button>
    </div>
  );
}
