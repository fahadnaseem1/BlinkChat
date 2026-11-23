// Start BlinkChat before checking joining, draft retention, uncertain sends, and session exit.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = process.env.BLINK_TEST_URL || 'http://localhost:8080';

(async () => {
    const browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    });
    try {
        const owner = await browser.newContext();
        const guest = await browser.newContext();
        const first = await owner.newPage();
        const second = await guest.newPage();
        for (const page of [first, second]) page.setDefaultTimeout(20000);
        async function screenshot(page, name) {
            if (!process.env.BLINK_SCREENSHOT_DIR) return;
            require('node:fs').mkdirSync(process.env.BLINK_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({
                path: `${process.env.BLINK_SCREENSHOT_DIR}/${name}.png`,
                fullPage: true,
                animations: 'disabled',
            });
        }
        const errors = [];
        for (const page of [first, second])
            page.on('pageerror', (error) => errors.push(error.message));
        let dropNextSend = false;
        let disconnectOnAcceptance = false;
        const sentOperations = [];
        await first.routeWebSocket('**/ws', (socket) => {
            const server = socket.connectToServer();
            socket.onMessage((frame) => {
                if (typeof frame === 'string' && frame.includes('destination:/app/chat.send')) {
                    const data = JSON.parse(
                        frame.slice(frame.indexOf('\n\n') + 2).replace(/\0$/, ''),
                    );
                    sentOperations.push(data.operationId);
                    if (dropNextSend) {
                        dropNextSend = false;
                        return;
                    }
                }
                server.send(frame);
            });
            server.onMessage((frame) => {
                if (
                    disconnectOnAcceptance &&
                    typeof frame === 'string' &&
                    frame.includes('message.accepted')
                ) {
                    disconnectOnAcceptance = false;
                    socket.close();
                    server.close();
                    return;
                }
                socket.send(frame);
            });
        });
        async function snapshot(id) {
            return (await owner.request.get(`${origin}/api/rooms/${id}`)).json();
        }
        async function select(id) {
            await first.locator(`[data-room-id="${id}"]`).click();
            await first.waitForFunction(
                () => document.querySelector('#connection').dataset.state === 'ready',
            );
        }
        async function create(title) {
            await first.locator('#new-room').click();
            await first.locator('#chat-name').fill(title);
            await first.locator('#create-submit').click();
            await first.waitForFunction(
                (title) =>
                    document.querySelector('#room-title').textContent === title &&
                    document.querySelector('#invite-link').value.includes('#invite='),
                title,
            );
            return {
                id: new URL(first.url()).hash.slice(6),
                invitation: await first.locator('#invite-link').inputValue(),
            };
        }
        await first.goto(origin);
        await first.locator('#name').fill('Alex');
        await first.locator('#enter').click();
        const picnic = await create('Weekend plans');
        const movies = await create('Movie night');
        assert.notEqual(picnic.id, movies.id);

        await second.goto(picnic.invitation);
        await second
            .locator('#preview-title')
            .getByText('Weekend plans', { exact: true })
            .waitFor();
        assert.match(await second.locator('#preview-people').textContent(), /1 of 20 people/);
        assert.match(await second.locator('#preview-policy').textContent(), /10s/);
        assert.equal(
            (await snapshot(picnic.id)).room.participants.length,
            1,
            'Preview must not join',
        );
        assert.equal(
            (await guest.request.get(origin + '/api/me')).status(),
            401,
            'Preview must not create an identity',
        );
        await second.locator('#name').fill('Sam');
        await second.locator('#enter').click();
        await second.waitForFunction(() => !document.querySelector('#draft').disabled);
        const guestIdentity = await (await guest.request.get(origin + '/api/me')).json();
        await second.goto(movies.invitation);
        await second.getByRole('button', { name: 'Join as Sam', exact: true }).waitFor();
        assert.equal(await second.locator('#name').isVisible(), false);
        await second.setViewportSize({ width: 360, height: 780 });
        await second.waitForTimeout(150);
        await screenshot(second, 'returning-invitation-mobile');
        assert.equal(
            await second.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
        );
        await second.setViewportSize({ width: 1280, height: 800 });
        await second.locator('#change-name').click();
        await second.locator('#name').fill('Sammy');
        await second.locator('#enter').click();
        await second.waitForFunction(
            () => document.querySelector('#guest-name').textContent === 'Sammy',
        );
        await second.waitForFunction(() => !document.querySelector('#draft').disabled);
        const renamed = await (await guest.request.get(origin + '/api/me')).json();
        assert.equal(renamed.id, guestIdentity.id);
        assert.equal(renamed.displayName, 'Sammy');
        console.log(
            'PASS: invitation preview has no membership side effects; returning guests reuse their identity and can rename',
        );

        await select(picnic.id);
        await first.locator('#draft').fill('Draft for the weekend');
        await select(movies.id);
        assert.equal(await first.locator('#draft').inputValue(), '');
        await first.locator('#draft').fill('Draft for movie night');
        await select(picnic.id);
        assert.equal(await first.locator('#draft').inputValue(), 'Draft for the weekend');
        await select(movies.id);
        assert.equal(await first.locator('#draft').inputValue(), 'Draft for movie night');
        await select(picnic.id);
        assert.deepEqual(
            await first.evaluate(() => ({
                local: Object.keys(localStorage),
                session: Object.keys(sessionStorage),
            })),
            { local: [], session: [] },
        );
        console.log(
            'PASS: drafts survive navigation, stay isolated by chat, and are not persisted to browser storage',
        );

        // Keep a third original recipient without an open page so content remains unread during checks.
        const third = await browser.newContext();
        const thirdCsrf = await (await third.request.get(origin + '/api/csrf')).json();
        await third.request.post(origin + '/api/guests', {
            headers: { [thirdCsrf.headerName]: thirdCsrf.token },
            data: { displayName: 'Riley' },
        });
        await third.request.post(origin + '/api/invites/redeem', {
            headers: { [thirdCsrf.headerName]: thirdCsrf.token },
            data: { secret: new URL(picnic.invitation).hash.slice(8) },
        });
        await first.waitForFunction(
            () => document.querySelector('#chat-info').dataset.members === '3',
        );

        dropNextSend = true;
        await first.locator('#draft').fill('A send interrupted before acceptance');
        await first.locator('#send').click();
        await first.getByText('Sending…', { exact: true }).waitFor();
        await owner.setOffline(true);
        await first.getByText('Checking whether this was sent…', { exact: true }).waitFor();
        await owner.setOffline(false);
        await first.getByRole('button', { name: 'Retry', exact: true }).waitFor({ timeout: 5000 });
        await select(movies.id);
        assert.equal(await first.locator('#draft').inputValue(), 'Draft for movie night');
        await select(picnic.id);
        await first.getByRole('button', { name: 'Retry', exact: true }).waitFor();
        assert.equal((await snapshot(picnic.id)).messages.length, 0);
        await first.getByRole('button', { name: 'Retry', exact: true }).click();
        await first.locator('.own[data-id] .bubble').waitFor();
        assert.equal(sentOperations.length, 2);
        assert.equal(sentOperations[0], sentOperations[1], 'Retries keep the same operation ID');
        assert.equal((await snapshot(picnic.id)).messages.length, 1);
        await first.locator('.own[data-id] .bubble').first().click();
        assert.equal(await first.locator('#receipts-list li').count(), 2);
        assert.match(await first.locator('#receipts-list').textContent(), /Sammy/);
        assert.match(await first.locator('#receipts-list').textContent(), /Riley/);
        assert.match(
            await first.locator('#receipts-description').textContent(),
            /all 2 original recipients/,
        );
        await screenshot(first, 'receipt-details');
        await first.locator('#close-receipts').click();
        console.log(
            'PASS: uncertain sends survive chat switches; retry follows a server check and creates one message; receipts identify the original audience',
        );

        // Hide only snapshot bodies to force recovery through the canonical operation lookup.
        await first.route(`**/api/rooms/${picnic.id}`, async (route) => {
            const response = await route.fetch();
            const data = await response.json();
            data.messages = [];
            data.nextCursor = null;
            await route.fulfill({ response, json: data });
        });
        let operationLookups = 0;
        first.on('request', (request) => {
            if (request.url().includes('/operations/')) operationLookups++;
        });
        const recoveredOperation = first.waitForResponse(
            (response) => response.url().includes('/operations/') && response.status() === 200,
        );
        disconnectOnAcceptance = true;
        await first.locator('#draft').fill('Accepted before the connection dropped');
        await first.locator('#send').click();
        await recoveredOperation;
        await first
            .locator('[data-id]')
            .filter({ hasText: 'Accepted before the connection dropped' })
            .waitFor();
        await first.waitForFunction(
            () => !document.querySelector('#messages').textContent.includes('Checking whether'),
        );
        assert.ok(operationLookups > 0, 'Reconnection must check the uncertain operation');
        assert.equal(sentOperations.length, 3, 'Accepted sends must not be resent');
        assert.equal((await snapshot(picnic.id)).messages.length, 2);
        assert.equal(await first.getByRole('button', { name: 'Retry', exact: true }).count(), 0);
        await first.unroute(`**/api/rooms/${picnic.id}`);
        console.log(
            'PASS: a lost acceptance is recovered after reconnect without resending or duplicating the message',
        );

        await first.route(`**/api/rooms/${picnic.id}`, async (route) => {
            const response = await route.fetch();
            const data = await response.json();
            data.room.expiresAt = new Date(Date.parse(data.serverTime) + 240000).toISOString();
            await route.fulfill({ response, json: data });
        });
        await first.evaluate(() => window.dispatchEvent(new Event('focus')));
        await first.locator('#room-expiry').waitFor({ state: 'visible' });
        assert.match(await first.locator('#room-expiry-text').textContent(), /4 min/);
        await screenshot(first, 'room-expiry-warning');
        await first.locator('#fresh-chat').click();
        assert.equal(await first.locator('#fresh-start-note').isVisible(), true);
        assert.equal(await first.locator('#chat-name').inputValue(), 'Weekend plans');
        await first.locator('#chat-name').fill('A fresh conversation');
        await first.locator('#create-submit').click();
        await first.waitForFunction(
            () =>
                document.querySelector('#room-title').textContent === 'A fresh conversation' &&
                document.querySelector('#invite-link').value.includes('#invite='),
        );
        const freshId = new URL(first.url()).hash.slice(6);
        const freshInvitation = await first.locator('#invite-link').inputValue();
        const fresh = await snapshot(freshId);
        assert.equal(fresh.room.participants.length, 1);
        assert.equal(fresh.messages.length, 0);
        assert.equal(await first.locator('#draft').inputValue(), '');
        await first.unroute(`**/api/rooms/${picnic.id}`);
        console.log(
            'PASS: five-minute warning starts an empty, separate chat without carrying over members or messages',
        );

        const guestCsrf = await (await guest.request.get(origin + '/api/csrf')).json();
        await guest.request.post(origin + '/api/invites/redeem', {
            headers: { [guestCsrf.headerName]: guestCsrf.token },
            data: { secret: new URL(freshInvitation).hash.slice(8) },
        });
        await select(movies.id);
        await first.locator('#logout').click();
        assert.match(await first.locator('#logout-dialog').textContent(), /lose access/);
        await screenshot(first, 'end-session-confirmation');
        await first.locator('#cancel-logout').click();
        assert.equal(await first.locator('#draft').inputValue(), 'Draft for movie night');
        await first.locator('#logout').click();
        await first.locator('#confirm-logout').click();
        await first.locator('#welcome').waitFor({ state: 'visible' });
        assert.equal(await first.locator('#draft').inputValue(), '');
        assert.equal(await first.locator('#messages').textContent(), '');
        await first.locator('#name').fill('New guest');
        await first.locator('#enter').click();
        await first.locator('#shell').waitFor({ state: 'visible' });
        await first.waitForFunction(
            () => document.querySelector('#connection').dataset.state === 'ready',
        );
        assert.equal(await first.locator('.room-item').count(), 0);
        assert.equal(await first.locator('#room-title').textContent(), 'Your chats');
        assert.equal(await first.locator('#composer').isVisible(), false);
        assert.equal(await first.locator('#empty-create').isVisible(), true);
        for (const id of [picnic.id, movies.id, freshId])
            await guest.request.post(`${origin}/api/rooms/${id}/close`, {
                headers: { [guestCsrf.headerName]: guestCsrf.token },
            });
        const invalid = await browser.newPage();
        await invalid.goto(origin + '/#invite=unavailable-invitation');
        await invalid.locator('#preview-error').waitFor({ state: 'visible' });
        assert.equal(await invalid.locator('#enter').isDisabled(), true);
        await invalid.locator('#skip-invite').click();
        assert.equal(await invalid.locator('#join-preview').isVisible(), false);
        assert.equal(await invalid.locator('#enter').isEnabled(), true);
        // Use virtual browser time to exercise expiry without changing the server clock.
        await first.clock.install();
        await first.route('**/api/me', async (route) => {
            const response = await route.fetch();
            const data = await response.json();
            if (response.ok()) data.expiresAt = new Date(Date.now() + 5000).toISOString();
            await route.fulfill({ response, json: data });
        });
        await first.reload();
        await first.locator('#shell').waitFor({ state: 'visible' });
        const expiring = await create('Session expiry check');
        await guest.request.post(origin + '/api/invites/redeem', {
            headers: { [guestCsrf.headerName]: guestCsrf.token },
            data: { secret: new URL(expiring.invitation).hash.slice(8) },
        });
        await first.waitForFunction(() => !document.querySelector('#draft').disabled);
        await first.locator('#draft').fill('A private draft that must be cleared');
        await first.clock.fastForward(6000);
        await first.locator('#welcome').waitFor({ state: 'visible' });
        assert.equal(await first.locator('#draft').inputValue(), '');
        assert.equal(await first.locator('#messages').textContent(), '');
        await guest.request.post(`${origin}/api/rooms/${expiring.id}/close`, {
            headers: { [guestCsrf.headerName]: guestCsrf.token },
        });
        console.log(
            'PASS: automatic guest expiry clears local text without needing another HTTP request',
        );
        assert.deepEqual(errors, []);
        console.log(
            'PASS: cancelling session exit preserves drafts; confirming clears local text and the next guest has no old room access',
        );
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
});
