// Start BlinkChat before running this group invitation and message expiry check.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const origin = process.env.BLINK_TEST_URL || 'http://localhost:8080';
(async () => {
    const browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
    });
    try {
        const contexts = await Promise.all([
            browser.newContext(),
            browser.newContext(),
            browser.newContext({ viewport: { width: 360, height: 780 } }),
        ]);
        const [host, sam, riley] = await Promise.all(contexts.map((c) => c.newPage()));
        const errors = [];
        for (const p of [host, sam, riley]) {
            p.setDefaultTimeout(20000);
            p.on('pageerror', (e) => errors.push(e.message));
        }
        await host.goto(origin);
        await host.locator('#name').fill('Alex');
        await host.locator('#enter').click();
        await host.locator('#new-room').click();
        await host.locator('#chat-name').fill('Friends together');
        await host.locator('#create-submit').click();
        await host.waitForFunction(() =>
            document.querySelector('#invite-link').value.includes('#invite='),
        );
        const invitation = await host.locator('#invite-link').inputValue();
        const secret = new URL(invitation).hash.slice(8);
        const roomId = new URL(host.url()).hash.slice(6);
        async function join(page, name) {
            await page.goto(invitation);
            await page.locator('#name').fill(name);
            await page.locator('#enter').click();
            await page.waitForFunction(() => !document.querySelector('#draft').disabled);
        }
        await join(sam, 'Sam');
        await host.locator('#invite-friends').click();
        assert.equal(
            await host.locator('#invite-link').inputValue(),
            invitation,
            'The same invitation must survive the first join',
        );
        await host.locator('#close-invite').click();
        await join(riley, 'Riley');
        await host.waitForFunction(
            () => document.querySelector('#chat-info').dataset.members === '3',
        );
        for (const page of [host, sam, riley]) {
            assert.equal(new URL(page.url()).hash.slice(6), roomId);
        }
        await host.locator('#chat-info').click();
        assert.equal(await host.locator('#members-list li').count(), 3);
        await host.locator('#close-details').click();
        console.log(
            'PASS: three independent guests joined the exact same link; members and active-chat invitation work',
        );

        // Headless Chrome can focus every browser context at once. Hold Riley's
        // view receipt until this scenario explicitly brings that participant back.
        await riley.evaluate(() => {
            const hasFocus = document.hasFocus.bind(document);
            window.testViewEnabled = false;
            document.hasFocus = () => window.testViewEnabled && hasFocus();
        });
        await host.bringToFront();
        await host.locator('#draft').fill('A fictional message for our group');
        await host.locator('#send').click();
        await sam.bringToFront();
        await sam.getByText('A fictional message for our group', { exact: true }).waitFor();
        assert.equal(await sam.locator('.message-author').first().textContent(), 'Alex');
        // Poll in Node: waitForFunction treats an async predicate's Promise as truthy.
        async function waitForViews(count) {
            const deadline = Date.now() + 20000;
            while (Date.now() < deadline) {
                const snapshot = await (
                    await contexts[0].request.get(origin + '/api/rooms/' + roomId)
                ).json();
                if (snapshot.messages[0]?.seenCount === count) return snapshot;
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
            assert.fail(`Timed out waiting for ${count} message views`);
        }
        const before = await waitForViews(1);
        assert.equal(before.messages[0].recipientCount, 2);
        assert.equal(before.messages[0].seenAt, null);
        assert.ok(
            Date.parse(before.messages[0].disappearsAt) - Date.parse(before.serverTime) > 30000,
        );

        const later = await browser.newContext();
        const csrf = await (await later.request.get(origin + '/api/csrf')).json();
        await later.request.post(origin + '/api/guests', {
            headers: { [csrf.headerName]: csrf.token },
            data: { displayName: 'Taylor' },
        });
        const joined = await later.request.post(origin + '/api/invites/redeem', {
            headers: { [csrf.headerName]: csrf.token },
            data: { secret },
        });
        assert.equal(joined.status(), 200);
        const laterSnapshot = await (
            await later.request.get(origin + '/api/rooms/' + roomId)
        ).json();
        assert.equal(
            laterSnapshot.messages.length,
            0,
            'Later members must not receive earlier bodies',
        );
        console.log(
            'PASS: per-person receipts wait for all original recipients; a fourth guest reuses the link without gaining earlier content',
        );

        await riley.bringToFront();
        await riley.evaluate(() => {
            window.testViewEnabled = true;
            window.dispatchEvent(new Event('focus'));
        });
        await riley.getByText('A fictional message for our group', { exact: true }).waitFor();
        const after = await waitForViews(2);
        assert.ok(after.messages[0].seenAt, 'All original viewers must start the grace period');
        assert.equal(
            after.messages[0].recipientCount,
            2,
            'Later joins must not extend the original audience',
        );
        assert.ok(
            Date.parse(after.messages[0].disappearsAt) - Date.parse(after.serverTime) <= 10000,
        );
        assert.equal(await riley.locator('.message-timer').count(), 0);
        await riley.locator('.bubble').first().click();
        await riley.locator('#receipts-expiry').waitFor();
        await riley.locator('#close-receipts').click();
        assert.equal(
            await riley.evaluate(() => document.documentElement.scrollWidth > innerWidth),
            false,
        );
        if (process.env.BLINK_SCREENSHOT_DIR) {
            require('node:fs').mkdirSync(process.env.BLINK_SCREENSHOT_DIR, { recursive: true });
            await riley.screenshot({
                path: process.env.BLINK_SCREENSHOT_DIR + '/group-mobile.png',
            });
        }
        await riley.waitForFunction(
            () =>
                !document
                    .querySelector('#messages')
                    .textContent.includes('A fictional message for our group'),
            {},
            { timeout: 16000 },
        );
        await riley.reload();
        await riley.waitForFunction(
            () => document.querySelector('#connection').dataset.state === 'ready',
        );
        assert.ok(
            !(await riley.locator('#messages').textContent()).includes(
                'A fictional message for our group',
            ),
        );
        console.log(
            'PASS: group-wide expiry after all original viewers, mobile fit, and refresh without resurrection',
        );

        await riley.locator('#draft').fill('Riley joins the conversation');
        await riley.locator('#send').click();
        await host.bringToFront();
        await host.getByText('Riley joins the conversation', { exact: true }).waitFor();
        assert.equal(await host.locator('.message-author').first().textContent(), 'Riley');
        await host.locator('#chat-options').click();
        await host.locator('#end').click();
        await host.locator('#confirm-end').click();
        await riley.getByText('This moment has passed.', { exact: true }).waitFor();
        const closed = await later.request.post(origin + '/api/invites/redeem', {
            headers: { [csrf.headerName]: csrf.token },
            data: { secret },
        });
        assert.equal(closed.status(), 409);
        assert.deepEqual(errors, []);
        console.log(
            'PASS: members can send with clear authorship; ending the group clears messages and disables the shared invitation',
        );
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
});
