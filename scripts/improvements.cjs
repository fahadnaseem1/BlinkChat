// Start BlinkChat first. Exercise the new controls with independent guest identities.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = process.env.BLINK_TEST_URL || 'http://localhost:8080';
(async () => {
    const browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    });
    try {
        const hostContext = await browser.newContext({ viewport: { width: 360, height: 780 } });
        const guestContext = await browser.newContext();
        await hostContext.addInitScript(() => {
            navigator.share = async (data) => {
                window.sharedInvitation = data;
            };
        });
        const host = await hostContext.newPage();
        const guest = await guestContext.newPage();
        const errors = [];
        for (const p of [host, guest]) {
            p.setDefaultTimeout(20000);
            p.on('pageerror', (e) => errors.push(e.message));
        }
        await host.goto(origin);
        await host.locator('#name').fill('Morgan');
        await host.locator('#enter').click();
        await host.locator('#new-room').click();
        await host.locator('#chat-name').fill('New controls');
        await host.locator('#read-grace').selectOption('30');
        await host.locator('#create-submit').click();
        await host.waitForFunction(() =>
            document.querySelector('#invite-link').value.includes('#invite='),
        );
        const invitation = await host.locator('#invite-link').inputValue();
        const roomId = new URL(host.url()).hash.slice(6);
        await host.locator('#share').click();
        assert.equal(await host.evaluate(() => window.sharedInvitation.url), invitation);
        await host.locator('#invite-qr-details summary').click();
        if (process.env.BLINK_SCREENSHOT_DIR) {
            require('node:fs').mkdirSync(process.env.BLINK_SCREENSHOT_DIR, { recursive: true });
            await host
                .locator('#invite-qr')
                .screenshot({ path: process.env.BLINK_SCREENSHOT_DIR + '/invitation-qr.png' });
        }
        const qrPixels = await host.locator('#invite-qr').evaluate((canvas) => {
            const data = canvas
                .getContext('2d')
                .getImageData(0, 0, canvas.width, canvas.height).data;
            return {
                url: canvas.dataset.url,
                width: canvas.width,
                dark: data.some((v, i) => i % 4 === 0 && v === 0),
            };
        });
        assert.equal(qrPixels.url, invitation);
        assert.ok(qrPixels.width >= 100 && qrPixels.dark);
        assert.equal(
            await host.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
        );
        await guest.goto(invitation);
        await guest.locator('#name').fill('Avery');
        await guest.locator('#enter').click();
        await guest.waitForFunction(() => !document.querySelector('#draft').disabled);
        await host.waitForFunction(() => !document.querySelector('#draft').disabled);
        await guest.locator('#chat-options').click();
        assert.equal(await guest.locator('#end').isVisible(), false);
        assert.equal(await guest.locator('#leave').isVisible(), true);
        await guest.keyboard.press('Escape');
        const denied = await guest.evaluate(async (id) => {
            const csrf = await (await fetch('/api/csrf')).json();
            return (
                await fetch(`/api/rooms/${id}/close`, {
                    method: 'POST',
                    headers: { [csrf.headerName]: csrf.token },
                })
            ).status;
        }, roomId);
        assert.equal(denied, 403);
        await host.locator('#draft').fill('Focus should survive a new message');
        await host.locator('#send').click();
        await host.locator('.receipt-button').first().waitFor();
        await host.locator('.receipt-button').first().focus();
        await guest.locator('#draft').fill('Accessible arrival');
        await guest.locator('#send').click();
        await host.getByText('Accessible arrival', { exact: true }).waitFor();
        assert.equal(await host.evaluate(() => document.activeElement.dataset.action), 'receipt');
        assert.match(
            await host.locator('#message-announcements').textContent(),
            /Avery sent a new message/,
        );
        await guest.bringToFront();
        await guest.waitForFunction(() => document.querySelector('.message-timer.expiring'));
        const snapshot = await (
            await hostContext.request.get(`${origin}/api/rooms/${roomId}`)
        ).json();
        assert.equal(snapshot.room.readGraceSeconds, 30);
        const viewed = snapshot.messages.find((m) => m.seenAt);
        assert.ok(viewed);
        assert.ok(Date.parse(viewed.disappearsAt) - Date.parse(viewed.seenAt) <= 30000);
        await guest.locator('.message-timer').first().click();
        assert.match(await guest.locator('#receipts-description').textContent(), /countdown/);
        await guest.locator('#close-receipts').click();
        console.log(
            'PASS: native sharing, local QR, custom countdown, member close denial, arrival announcements, keyboard focus',
        );
        await guest.locator('#draft').fill('This draft must be cleared');
        await guest.locator('#chat-options').click();
        await guest.locator('#leave').click();
        await guest.locator('#confirm-leave').click();
        await guest.waitForFunction(
            () => !location.hash && document.querySelector('#room-count').textContent === '0',
        );
        assert.equal(await guest.locator('#draft').inputValue(), '');
        assert.equal(
            (await guestContext.request.get(`${origin}/api/rooms/${roomId}`)).status(),
            404,
        );
        await host.waitForFunction(
            () => document.querySelector('#members-button').textContent === 'Members (1)',
        );
        assert.equal(await host.locator('#draft').isDisabled(), true);
        await host.locator('#chat-options').click();
        await host.locator('#leave').click();
        await host.locator('#confirm-leave').click();
        await host.waitForFunction(
            () => !location.hash && document.querySelector('#room-count').textContent === '0',
        );
        assert.equal(await host.locator('#invite-qr').evaluate((c) => c.dataset.url), undefined);
        assert.deepEqual(errors, []);
        console.log(
            'PASS: leave revokes access, clears drafts, updates peers, and final departure clears invitation QR',
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
