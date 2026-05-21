const API = import.meta.env.VITE_WP_API_URL;
const TOKEN_KEY = 'vitro_jwt';

// ── Token storage ─────────────────────────────────────────────────────────────

export const getToken   = ()      => localStorage.getItem(TOKEN_KEY);
export const setToken   = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = ()      => localStorage.removeItem(TOKEN_KEY);

// ── Login ─────────────────────────────────────────────────────────────────────

export async function loginUser(username, password) {
    const res = await fetch(`${API}/wp-json/jwt-auth/v1/token`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username, password }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
        const raw = data?.message ?? 'Login failed. Check your credentials.';
        throw new Error(raw.replace(/<[^>]*>/g, ''));
    }

    const token = data.token ?? data.data?.token;
    if (!token) throw new Error('Server returned no token.');

    setToken(token);
    return token;
}

// ── Subscription check ────────────────────────────────────────────────────────

export async function checkSubscription() {
    const token = getToken();
    if (!token) return 'unauthenticated';

    let res;
    try {
        res = await fetch(`${API}/wp-json/vitro/v1/check-access`, {
            method:  'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
            },
        });
    } catch {
        return 'unauthenticated';
    }

    if (res.status === 401 || res.status === 403) {
        clearToken();
        return 'unauthenticated';
    }

    if (!res.ok) return 'no_subscription';

    const data = await res.json().catch(() => ({}));
    return Array.isArray(data.entitlements) &&
        (data.entitlements.includes('PLOTTER-ACCESS') || data.entitlements.includes('DEVPASSPLOTTER'))
        ? 'approved'
        : 'no_subscription';
}
