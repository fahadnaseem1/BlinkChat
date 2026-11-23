let csrf;
let csrfRequest;
// Share an in-flight token request so guest entry cannot race session initialization.
export async function initCsrf() {
    if (csrfRequest) {
        return csrfRequest;
    }
    csrfRequest = (async () => {
        const r = await fetch('/api/csrf', { cache: 'no-store' });
        if (!r.ok) {
            throw new Error('Could not prepare your session. Please try again.');
        }
        csrf = await r.json();
        return csrf;
    })();
    try {
        return await csrfRequest;
    } finally {
        csrfRequest = undefined;
    }
}
export async function api(path, method = 'GET', body) {
    const headers = {};
    if (method !== 'GET') {
        if (!csrf) {
            await initCsrf();
        }
        headers['Content-Type'] = 'application/json';
        headers[csrf.headerName] = csrf.token;
    }
    const r = await fetch('/api' + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
    });
    const data = await r.json();
    if (!r.ok) {
        const e = new Error(data.message || 'Request failed. Please try again.');
        e.status = r.status;
        e.category = data.category;
        throw e;
    }
    return data;
}
