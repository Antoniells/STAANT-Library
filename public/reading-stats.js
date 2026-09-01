// Estatísticas de leitura (tempo por dia, sequência de dias, total).
// Fica no localStorage porque é dado leve, pessoal e por dispositivo — não vale
// o custo de leitura/escrita no Firestore a cada minuto de leitura.
const STATS_KEY = 'staant_reading_stats';

function todayKey(date = new Date()) {
    // Data local (não UTC), pra "hoje" bater com o dia do usuário
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function loadStats() {
    try {
        const raw = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
        return { days: raw.days || {} };
    } catch (_) {
        return { days: {} };
    }
}

function saveStats(stats) {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (_) {}
}

// Soma minutos lidos no dia de hoje. Chamado pelo leitor a cada minuto ativo.
export function addReadingMinutes(minutes = 1) {
    const stats = loadStats();
    const key = todayKey();
    stats.days[key] = (stats.days[key] || 0) + minutes;
    saveStats(stats);
    return stats;
}

export function minutesToday() {
    return loadStats().days[todayKey()] || 0;
}

// Sequência de dias consecutivos com leitura, contando de hoje (ou de ontem,
// se ainda não leu hoje — assim a sequência não "quebra" antes do dia acabar).
export function currentStreak() {
    const { days } = loadStats();
    const cursor = new Date();
    if (!days[todayKey(cursor)]) cursor.setDate(cursor.getDate() - 1);

    let streak = 0;
    while (days[todayKey(cursor)]) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
}

// Minutos por dia nos últimos N dias, do mais antigo pro mais recente.
export function lastDays(n = 7) {
    const { days } = loadStats();
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        out.push({ date: todayKey(d), minutes: days[todayKey(d)] || 0 });
    }
    return out;
}

export function totalMinutes() {
    return Object.values(loadStats().days).reduce((sum, m) => sum + m, 0);
}

// "45 min" / "2h 15min" — formato curto pra caber nos cards
export function formatMinutes(mins) {
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}min`;
}
