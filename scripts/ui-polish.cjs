// Start BlinkChat before checking compact controls, loading, and mobile entry.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = process.env.BLINK_TEST_URL || 'http://localhost:8080';

(async () => {
    const browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    });
    try {
        const context = await browser.newContext({
            permissions: ['clipboard-read', 'clipboard-write'],
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const mobile = await browser.newPage({ viewport: { width: 360, height: 640 } });
        await mobile.goto(origin);
        const entryButton = await mobile.locator('#enter').boundingBox();
        assert.ok(
            entryButton.y + entryButton.height <= 640,
            'Mobile entry action must be above the fold',
        );
        assert.equal(
            await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
        );
        if (process.env.BLINK_SCREENSHOT_DIR) {
            require('node:fs').mkdirSync(process.env.BLINK_SCREENSHOT_DIR, { recursive: true });
            await mobile.screenshot({
                path: process.env.BLINK_SCREENSHOT_DIR + '/welcome-mobile.png',
            });
        }
        await page.goto(origin);
        await page.locator('#name').fill('Alex');
        await page.locator('#enter').click();
        await page.locator('#shell').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#chat-list-help').count(), 0);

        async function create(title) {
            await page.locator('#new-room').click();
            assert.equal(await page.locator('#message-settings').count(), 0);
            await page.locator('#chat-name').fill(title);
            await page.locator('#create-submit').click();
            await page.waitForFunction(
                (title) =>
                    document.querySelector('#room-title').textContent === title &&
                    document.querySelector('#invite-link').value.includes('#invite='),
                title,
            );
            return new URL(page.url()).hash.slice(6);
        }
        const first = await create('Weekend plans');
        assert.equal(await page.locator('.room-group-label').count(), 0);
        assert.equal(await page.locator('.room-item-code').count(), 0);
        await page.getByRole('heading', { name: 'No messages yet', exact: true }).waitFor();
        assert.equal(await page.locator('#presence').count(), 0);
        assert.equal(await page.locator('header > .avatar').count(), 0);
        assert.equal(await page.locator('#invite-friends').isVisible(), false);
        assert.equal(await page.locator('#waiting').innerText(), 'No messages yet\nInvite');
        await page.locator('#waiting-invite').click();
        await page.locator('#copy').click();
        await page.getByRole('button', { name: '✓ Copied!', exact: true }).waitFor();
        assert.equal(
            await page.evaluate(() => navigator.clipboard.readText()),
            await page.locator('#invite-link').inputValue(),
        );
        assert.equal(await page.locator('#invite-dialog #regenerate').count(), 0);
        await page.locator('#close-invite').click();
        await page.locator('#chat-info').click();
        await page.locator('#invite-management summary').click();
        assert.equal(await page.locator('#regenerate').isVisible(), true);
        await page.locator('#close-details').click();

        assert.equal(await page.locator('#end').isVisible(), false);
        await page.locator('#chat-options').click();
        assert.deepEqual(
            await page
                .locator('#chat-actions > button:visible')
                .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim())),
            ['Invite', 'Leave chat', 'End for everyone'],
        );
        await page.keyboard.press('Escape');
        await page.locator('#chat-info').click();
        assert.equal(await page.locator('#chat-details').isVisible(), true);
        assert.match(await page.locator('#chat-code').textContent(), /^Chat [0-9A-F]{6}$/);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#chat-details').isVisible(), false);
        await page.locator('#chat-info').click();
        assert.equal(await page.locator('#chat-details').isVisible(), true);
        await page.keyboard.press('Escape');

        const second = await create('Movie night');
        assert.notEqual(first, second);
        let releaseSnapshot;
        const snapshotGate = new Promise((resolve) => {
            releaseSnapshot = resolve;
        });
        await page.route(`**/api/rooms/${first}`, async (route) => {
            await snapshotGate;
            await route.continue();
        });
        await page.locator(`[data-room-id="${first}"]`).click();
        await page.locator('#chat-loading').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#messages').isVisible(), false);
        assert.equal(await page.locator('#composer').isVisible(), false);
        releaseSnapshot();
        await page.locator('#chat-loading').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#connection-banner').isVisible(), false);
        await context.setOffline(true);
        await page.locator('#connection-banner').waitFor({ state: 'visible' });
        assert.match(await page.locator('#connection-banner').textContent(), /offline/i);
        await context.setOffline(false);
        await page.waitForFunction(
            () => document.querySelector('#connection').dataset.state === 'ready',
        );

        if (process.env.BLINK_SCREENSHOT_DIR) {
            await page.screenshot({
                path: process.env.BLINK_SCREENSHOT_DIR + '/waiting-desktop.png',
            });
            await page.setViewportSize({ width: 360, height: 780 });
            await page.waitForTimeout(150);
            await page.screenshot({
                path: process.env.BLINK_SCREENSHOT_DIR + '/waiting-mobile.png',
            });
            assert.equal(
                await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
                false,
            );
        }
        const invitation = await page.locator('#invite-link').inputValue();
        const friendContext = await browser.newContext();
        const friend = await friendContext.newPage();
        await friend.goto(invitation);
        await friend.locator('#name').fill('Sam');
        await friend.locator('#enter').click();
        await friend.waitForFunction(() => !document.querySelector('#draft').disabled);
        // A third member without an open page keeps these messages unread during layout checks.
        const third = await browser.newContext();
        const csrf = await (await third.request.get(origin + '/api/csrf')).json();
        await third.request.post(origin + '/api/guests', {
            headers: { [csrf.headerName]: csrf.token },
            data: { displayName: 'Riley' },
        });
        await third.request.post(origin + '/api/invites/redeem', {
            headers: { [csrf.headerName]: csrf.token },
            data: { secret: new URL(invitation).hash.slice(8) },
        });
        await friend.waitForFunction(
            () => document.querySelector('#chat-info').dataset.members === '3',
        );
        for (const text of ['See you this weekend', 'I will bring the snacks']) {
            await friend.locator('#draft').fill(text);
            await friend.locator('#send').click();
            await friend.getByText(text, { exact: true }).waitFor();
        }
        await page.setViewportSize({ width: 360, height: 780 });
        await page.locator('#draft').focus();
        await page.setViewportSize({ width: 360, height: 430 });
        await page.evaluate(() => visualViewport.dispatchEvent(new Event('resize')));
        const mobileChatLayout = await page.evaluate(() => {
            const shell = document.querySelector('#shell').getBoundingClientRect();
            const composer = document.querySelector('#composer').getBoundingClientRect();
            return {
                fixed: getComputedStyle(document.querySelector('#shell')).position === 'fixed',
                shellBottom: shell.bottom,
                composerBottom: composer.bottom,
                viewportHeight: visualViewport.height,
                windowHeight: innerHeight,
                visibleViewportVar: getComputedStyle(document.documentElement).getPropertyValue(
                    '--visible-viewport-height',
                ),
                messagesHeight: document.querySelector('#messages').clientHeight,
            };
        });
        assert.equal(mobileChatLayout.fixed, true, 'The mobile chat stays anchored above the keyboard');
        assert.ok(
            mobileChatLayout.shellBottom <= mobileChatLayout.viewportHeight + 1,
            `The chat shell must fit in the visible viewport: ${JSON.stringify(mobileChatLayout)}`,
        );
        assert.ok(
            mobileChatLayout.composerBottom <= mobileChatLayout.viewportHeight + 1,
            'The composer must stay above the keyboard',
        );
        assert.ok(mobileChatLayout.messagesHeight > 0, 'Messages stay visible above the composer');
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.getByText('I will bring the snacks', { exact: true }).waitFor();
        assert.equal(
            await page.locator('.message-author').count(),
            1,
            'Consecutive messages share one author label',
        );
        assert.equal(await page.locator('.bubble-row.grouped').count(), 1);
        assert.equal(await page.locator('.message-timer').count(), 0);
        assert.equal(await page.locator('#invite-dialog').count(), 1);
        assert.equal(await page.locator('#messages .sender-avatar').count(), 0);
        assert.equal(await page.locator('#invite-friends').isVisible(), false);
        assert.equal(await page.locator('#composer-help, #count').count(), 0);
        assert.equal(await page.locator('#send').getAttribute('aria-label'), 'Send');
        await page.locator('#chat-options').click();
        assert.equal(await page.locator('#invite-friends').isVisible(), true);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#end').isVisible(), false);
        if (process.env.BLINK_SCREENSHOT_DIR) {
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.waitForTimeout(150);
            await page.screenshot({ path: process.env.BLINK_SCREENSHOT_DIR + '/chat-desktop.png' });
            await page.setViewportSize({ width: 360, height: 780 });
            await page.waitForTimeout(150);
            await page.screenshot({ path: process.env.BLINK_SCREENSHOT_DIR + '/chat-mobile.png' });
            assert.equal(
                await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
                false,
            );
        }
        if (await page.locator('#toast').isVisible()) {
            const toast = await page.locator('#toast').boundingBox();
            const composer = await page.locator('#composer').boundingBox();
            assert.ok(toast.y + toast.height <= composer.y, 'Toasts must not cover the composer');
        }
        // Remove only the fictional rooms allocated by this check.
        await page.evaluate(
            async (ids) => {
                const csrf = await (await fetch('/api/csrf')).json();
                for (const id of ids)
                    await fetch(`/api/rooms/${id}/close`, {
                        method: 'POST',
                        headers: { [csrf.headerName]: csrf.token },
                    });
            },
            [first, second],
        );
        assert.deepEqual(errors, []);
        console.log(
            'PASS: mobile entry, sidebar, copy feedback, popover keyboard controls, loading, offline recovery, and sender grouping',
        );
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
});
