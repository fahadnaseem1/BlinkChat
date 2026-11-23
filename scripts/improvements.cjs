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
            navigator.canShare = (data) => Boolean(data.files?.length);
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
        await host.locator('#enter').click();
        await host.locator('#shell').waitFor({ state: 'visible' });
        const hostAlias = await host.locator('#guest-name').textContent();
        assert.match(hostAlias, /^Guest [0-9A-F]{6}$/);
        await host.locator('#new-room').click();
        await host.locator('#chat-name').fill('New controls');
        assert.equal(await host.locator('#message-settings').count(), 0);
        await host.locator('#create-submit').click();
        await host.waitForFunction(() =>
            document.querySelector('#invite-link').value.includes('#invite='),
        );
        const invitation = await host.locator('#invite-link').inputValue();
        const roomId = new URL(host.url()).hash.slice(6);
        await host.locator('#waiting-invite').click();
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
        await host.getByRole('button', { name: 'Share QR', exact: true }).click();
        const sharedImage = await host.evaluate(async () => {
            const file = window.sharedInvitation.files[0];
            return {
                name: file.name,
                type: file.type,
                signature: [...new Uint8Array(await file.arrayBuffer()).slice(0, 8)],
            };
        });
        assert.equal(sharedImage.name, 'blinkchat-invitation.png');
        assert.equal(sharedImage.type, 'image/png');
        assert.deepEqual(sharedImage.signature, [137, 80, 78, 71, 13, 10, 26, 10]);
        // Unsupported file sharing downloads the same PNG instead.
        await host.evaluate(() => {
            navigator.canShare = () => false;
        });
        const downloadReady = host.waitForEvent('download');
        await host.locator('#qr-share').click();
        const downloaded = await downloadReady;
        assert.equal(downloaded.suggestedFilename(), 'blinkchat-invitation.png');
        assert.ok(await downloaded.path());
        await host.locator('#close-invite').click();
        const anonymousContext = await browser.newContext();
        const anonymous = await anonymousContext.newPage();
        await anonymous.goto(invitation);
        await anonymous.locator('#enter').click();
        await anonymous.waitForFunction(() => !document.querySelector('#draft').disabled);
        const joinedAlias = await anonymous.locator('#guest-name').textContent();
        assert.match(joinedAlias, /^Guest [0-9A-F]{6}$/);
        assert.notEqual(joinedAlias, hostAlias);
        assert.equal(new URL(anonymous.url()).hash.slice(6), roomId);
        await anonymous.locator('#chat-info').click();
        assert.equal(await anonymous.locator('#members-list li').count(), 2);
        await anonymous.locator('#close-details').click();
        await anonymous.locator('#chat-options').click();
        await anonymous.locator('#leave').click();
        await anonymous.locator('#confirm-leave').click();
        await anonymous.waitForFunction(() => !location.hash);
        await anonymousContext.close();
        console.log(
            'PASS: optional random nicknames, anonymous invitation joining, clickable member count, QR image sharing and download',
        );
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
        await host.locator('.own[data-id] .bubble').first().waitFor();
        await host.locator('.own[data-id] .bubble').first().focus();
        await guest.locator('#draft').fill('Accessible arrival');
        await guest.locator('#send').click();
        await host.getByText('Accessible arrival', { exact: true }).waitFor();
        assert.equal(await host.evaluate(() => document.activeElement.dataset.action), 'details');
        assert.match(
            await host.locator('#message-announcements').textContent(),
            /Avery sent a new message/,
        );
        await guest.bringToFront();
        await guest.locator('.bubble').first().click();
        await guest.waitForFunction(() =>
            document.querySelector('#receipts-description').textContent.includes('Everyone'),
        );
        assert.equal(await guest.locator('.message-timer').count(), 0);
        const snapshot = await (
            await hostContext.request.get(`${origin}/api/rooms/${roomId}`)
        ).json();
        const viewed = snapshot.messages.find((m) => m.seenAt);
        assert.ok(viewed);
        assert.equal(viewed.roomEndsAt, snapshot.room.expiresAt);
        assert.equal(await guest.locator('#receipts-expiry').count(), 0);
        assert.match(await guest.locator('#receipts-description').textContent(), /viewed/);
        await guest.locator('#close-receipts').click();
        console.log(
            'PASS: native sharing, local QR, member close denial, arrival announcements, and keyboard focus',
        );
        await guest.locator('#draft').fill('This draft must be cleared');
        await guest.locator('#chat-options').click();
        await guest.locator('#leave').click();
        await guest.locator('#confirm-leave').click();
        await guest.waitForFunction(
            () => !location.hash && document.querySelectorAll('.room-item').length === 0,
        );
        assert.equal(await guest.locator('#draft').inputValue(), '');
        assert.equal(
            (await guestContext.request.get(`${origin}/api/rooms/${roomId}`)).status(),
            404,
        );
        await host.waitForFunction(
            () => document.querySelector('#chat-info').dataset.members === '1',
        );
        assert.equal(await host.locator('#draft').isDisabled(), true);
        await host.locator('#chat-options').click();
        await host.locator('#leave').click();
        await host.locator('#confirm-leave').click();
        await host.waitForFunction(
            () => !location.hash && document.querySelectorAll('.room-item').length === 0,
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
