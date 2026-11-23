// Start BlinkChat before running this chat isolation and navigation check.
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
        const friend = await browser.newContext({ viewport: { width: 360, height: 780 } });
        const first = await owner.newPage();
        const second = await friend.newPage();
        for (const page of [first, second]) {
            page.setDefaultTimeout(15000);
        }
        const errors = [];
        for (const page of [first, second]) {
            page.on('pageerror', (e) => errors.push(e.message));
        }
        await first.goto(origin);
        await first.locator('#name').fill('Alex');
        await first.locator('#enter').click();
        await first.waitForFunction(
            () => document.querySelector('#connection').dataset.state === 'ready',
        );

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
                code: await first.locator('#chat-code').textContent(),
                invitation: await first.locator('#invite-link').inputValue(),
            };
        }
        const picnic = await create('Weekend plans');
        const movies = await create('Movie night');
        assert.notEqual(picnic.id, movies.id);
        assert.notEqual(picnic.code, movies.code);
        assert.notEqual(picnic.invitation, movies.invitation);
        assert.equal(await first.locator('.room-item').count(), 2);
        assert.equal(
            await first.locator('[aria-current="true"]').getAttribute('data-room-id'),
            movies.id,
        );
        const select = (id) => first.locator(`[data-room-id="${id}"]`).click();
        await select(picnic.id);
        assert.equal(await first.locator('#invite-link').inputValue(), picnic.invitation);
        await select(movies.id);
        assert.equal(await first.locator('#invite-link').inputValue(), movies.invitation);
        console.log(
            'PASS: named chats, distinct matching codes, selected state, and separate invitations',
        );
        if (process.env.BLINK_SCREENSHOT_DIR) {
            require('node:fs').mkdirSync(process.env.BLINK_SCREENSHOT_DIR, { recursive: true });
            await first.screenshot({
                path: process.env.BLINK_SCREENSHOT_DIR + '/chats-desktop.png',
            });
        }

        await second.goto(picnic.invitation);
        await second.locator('#name').fill('Sam');
        await second.locator('#enter').click();
        await second.waitForFunction(() => !document.querySelector('#draft').disabled);
        assert.equal(await second.locator('#room-title').textContent(), 'Weekend plans');
        assert.equal(await second.locator('#chat-code').textContent(), picnic.code);
        if (process.env.BLINK_SCREENSHOT_DIR) {
            await second.screenshot({
                path: process.env.BLINK_SCREENSHOT_DIR + '/chat-mobile.png',
            });
        }
        await second.locator('#draft').fill('Only in the weekend chat');
        await second.locator('#send').click();
        await first.locator(`[data-room-id="${picnic.id}"] .room-badge`).waitFor();
        assert.equal(await first.locator('#room-title').textContent(), 'Movie night');
        assert.ok(
            !(await first.locator('#messages').textContent()).includes('Only in the weekend chat'),
        );
        await select(picnic.id);
        await first.getByText('Only in the weekend chat', { exact: true }).waitFor();

        // Switching must clear the former conversation immediately, before the next snapshot arrives.
        let delay = true;
        await first.route(`**/api/rooms/${movies.id}`, async (route) => {
            if (delay) {
                delay = false;
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            await route.continue();
        });
        await select(movies.id);
        assert.equal(await first.locator('#room-title').textContent(), 'Movie night');
        assert.ok(
            !(await first.locator('#messages').textContent()).includes('Only in the weekend chat'),
        );
        assert.equal(await first.locator('#composer').isVisible(), false);
        await select(picnic.id);
        await first.waitForFunction(
            () => document.querySelector('#connection').dataset.state === 'ready',
        );
        await first.waitForTimeout(1200);
        assert.equal(await first.locator('#room-title').textContent(), 'Weekend plans');
        console.log(
            'PASS: other-chat notification, correct recipient, and late snapshots cannot mix chats',
        );

        await select(movies.id);
        await first.waitForFunction(
            () => document.querySelector('#connection').dataset.state === 'ready',
        );
        await first.reload();
        await first.waitForFunction(
            () => document.querySelector('#connection').dataset.state === 'ready',
        );
        assert.equal(await first.locator('#room-title').textContent(), 'Movie night');
        assert.equal(await first.locator('#copy').textContent(), 'Create link');
        await first.locator('#chat-options').click();
        await first.locator('#invite-friends').click();
        await first.locator('#copy').click();
        await first.waitForFunction(() =>
            document.querySelector('#invite-link').value.includes('#invite='),
        );
        assert.notEqual(await first.locator('#invite-link').inputValue(), picnic.invitation);
        assert.notEqual(await first.locator('#invite-link').inputValue(), movies.invitation);
        assert.equal(
            await first.locator('[aria-current="true"]').getAttribute('data-room-id'),
            movies.id,
        );
        assert.equal(
            await second.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
        );
        assert.deepEqual(errors, []);
        console.log(
            'PASS: refresh returns to the selected chat; refreshed invitations stay in that chat; mobile fits',
        );

        // Close only the fictional rooms created by this test.
        await first.evaluate(
            async (ids) => {
                const csrf = await (await fetch('/api/csrf')).json();
                for (const id of ids) {
                    await fetch(`/api/rooms/${id}/close`, {
                        method: 'POST',
                        headers: { [csrf.headerName]: csrf.token },
                    });
                }
            },
            [picnic.id, movies.id],
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
});
