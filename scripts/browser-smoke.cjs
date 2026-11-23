// Optional browser acceptance test. Start BlinkChat before running this script.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = process.env.BLINK_TEST_URL || 'http://localhost:8080';

(async () => {
    const browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    });
    try {
        const creator = await browser.newContext();
        const recipient = await browser.newContext({ viewport: { width: 360, height: 780 } });
        const first = await creator.newPage();
        const second = await recipient.newPage();
        first.setDefaultTimeout(15000);
        second.setDefaultTimeout(15000);
        const errors = [];
        for (const page of [first, second]) {
            page.on('pageerror', (e) => errors.push(e.message));
        }

        // A slow first token request must not allow guest entry to race initialization.
        let tokenRequests = 0;
        await first.route('**/api/csrf', async (route) => {
            if (++tokenRequests === 1) {
                await new Promise((resolve) => setTimeout(resolve, 750));
            }
            await route.continue();
        });

        await first.goto(origin);
        await first.locator('#name').fill('Alex');
        await first.locator('#enter').click();
        await first.locator('#new-room').click();
        await first.locator('#create-form button.primary').click();
        await first.locator('#invite-link').waitFor({ state: 'visible' });
        await first.waitForFunction(() =>
            document.querySelector('#invite-link').value.includes('#invite='),
        );
        const invitation = await first.locator('#invite-link').inputValue();
        await second.goto(invitation);
        await second.locator('#name').fill('Sam');
        await second.locator('#enter').click();
        await second.waitForFunction(() => !document.querySelector('#draft').disabled);
        await first.waitForFunction(() => !document.querySelector('#draft').disabled);

        await first.bringToFront();
        const text = 'A fictional moment <b>plain text</b>';
        await first.locator('#draft').fill(text);
        await first.locator('#send').click();
        await second.bringToFront();
        await second.getByText(text, { exact: true }).waitFor();
        await first.getByText('Seen', { exact: true }).waitFor();
        assert.equal(
            await second.locator('.bubble b').count(),
            0,
            'Message markup must stay plain text',
        );
        assert.equal(
            await second.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
            'Mobile must not overflow',
        );
        console.log('PASS: private invitation, real-time delivery, Seen, safe text, 360px layout');

        await second.waitForFunction(
            () => !document.querySelector('#messages').textContent.includes('A fictional moment'),
            {},
            { timeout: 16000 },
        );
        await second.reload();
        await second.waitForFunction(() =>
            document.querySelector('#connection').textContent.includes('up to date'),
        );
        assert.ok(!(await second.locator('#messages').textContent()).includes(text));
        console.log('PASS: read expiry and refresh cannot restore content');

        await first.locator('#chat-options').click();
        await first.locator('#end').click();
        await first.locator('#confirm-end').click();
        await second.getByText('This moment has passed.', { exact: true }).waitFor();
        assert.deepEqual(errors, []);
        console.log('PASS: closure reaches both browsers; no browser script errors');

        for (const kind of ['subscription', 'broker-send', 'missing-csrf']) {
            const blocked = await second.evaluate(async (kind) => {
                const csrf = await (await fetch('/api/csrf')).json();
                return new Promise((resolve) => {
                    let connected = false;
                    const client = new StompJs.Client({
                        brokerURL: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
                        connectHeaders:
                            kind === 'missing-csrf' ? {} : { [csrf.headerName]: csrf.token },
                        reconnectDelay: 0,
                        debug: () => {},
                    });
                    const finish = (result) => {
                        clearTimeout(timeout);
                        client.deactivate();
                        resolve(result);
                    };
                    const timeout = setTimeout(() => finish(false), 8000);
                    client.onConnect = () => {
                        connected = true;
                        if (kind === 'subscription') {
                            client.subscribe('/queue/private', () => finish(false));
                        } else if (kind === 'broker-send') {
                            client.publish({ destination: '/queue/events', body: '{}' });
                        } else {
                            finish(false);
                        }
                    };
                    client.onStompError = () => finish(kind === 'missing-csrf' || connected);
                    client.onWebSocketClose = () => finish(kind === 'missing-csrf' || connected);
                    client.activate();
                });
            }, kind);
            assert.equal(blocked, true, `${kind} must be rejected`);
        }
        console.log(
            'PASS: arbitrary subscription, direct broker send, and missing STOMP CSRF are rejected',
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
});
