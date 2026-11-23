import QRCode from './vendor/qr.js';
function drawQr(canvas, url) {
    const code = new QRCode(-1, 1); // Error correction level L; the payload is an ASCII URL.
    code.addData(url);
    code.make();
    const count = code.getModuleCount();
    const scale = 4;
    canvas.width = canvas.height = (count + 8) * scale;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000000';
    for (let row = 0; row < count; row++)
        for (let col = 0; col < count; col++) {
            if (code.isDark(row, col))
                context.fillRect((col + 4) * scale, (row + 4) * scale, scale, scale);
        }
}
export function createInvitations({
    $,
    getRoom,
    getMe,
    invitations,
    copiedInvitations,
    now,
    remaining,
    api,
    toast,
    fail,
}) {
    function showInvite() {
        const invitation =
            getRoom() && ['waiting', 'active'].includes(getRoom().state)
                ? invitations.get(getRoom().id)
                : null;
        const available = invitation && Date.parse(invitation.expiresAt) > now();
        for (const prefix of ['', 'group-']) {
            $(prefix + 'invite-link').value = available
                ? location.origin + '/#invite=' + invitation.secret
                : '';
            $(prefix + 'invite-link').hidden = !available;
            $(prefix + 'invite-label').hidden = !available;
            const copied = (copiedInvitations.get(getRoom()?.id + prefix) || 0) > performance.now();
            $(prefix + 'copy').textContent = copied
                ? '✓ Copied!'
                : available
                  ? 'Copy invite link'
                  : 'Create invitation';
            $(prefix + 'regenerate').hidden = !available;
            $(prefix + 'share').hidden = !available || typeof navigator.share !== 'function';
            const details = $(prefix + 'invite-qr-details');
            details.hidden = !available;
            if (available) {
                const url = location.origin + '/#invite=' + invitation.secret;
                const canvas = $(prefix + 'invite-qr');
                if (canvas.dataset.url !== url) {
                    drawQr(canvas, url);
                    canvas.dataset.url = url;
                }
            } else {
                details.open = false;
                const canvas = $(prefix + 'invite-qr');
                canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
                delete canvas.dataset.url;
            }
            $(prefix + 'invite-expiry').textContent = available
                ? 'Everyone can reuse this link · expires in ' + remaining(invitation.expiresAt)
                : 'Create one invitation and share it with all your friends.';
        }
    }

    async function generateInvite() {
        if (
            !getRoom() ||
            !['waiting', 'active'].includes(getRoom().state) ||
            getRoom().creatorId !== getMe().id
        ) {
            return;
        }
        const id = getRoom().id;
        copiedInvitations.delete(id);
        copiedInvitations.delete(id + 'group-');
        for (const prefix of ['', 'group-']) {
            $(prefix + 'copy').disabled = true;
            $(prefix + 'regenerate').disabled = true;
        }
        try {
            const invitation = await api('/rooms/' + id + '/invites', 'POST');
            invitations.set(id, invitation);
            if (getRoom()?.id === id) {
                showInvite();
            }
        } finally {
            if (getRoom()?.id === id) {
                for (const prefix of ['', 'group-']) {
                    $(prefix + 'copy').disabled = false;
                    $(prefix + 'regenerate').disabled = false;
                }
            }
        }
    }

    async function copyInvitation(prefix = '') {
        const id = getRoom()?.id;
        try {
            let invitation = invitations.get(id);
            if (!invitation || Date.parse(invitation.expiresAt) <= now()) {
                await generateInvite();
                if (getRoom()?.id !== id) return;
                invitation = invitations.get(id);
            }
            if (!invitation) return;
            await navigator.clipboard.writeText(location.origin + '/#invite=' + invitation.secret);
            copiedInvitations.set(id + prefix, performance.now() + 3000);
            if (getRoom()?.id === id) showInvite();
            toast('Invite link copied. Share it with your friends.');
        } catch (error) {
            if (getRoom()?.id !== id) return;
            const invitation = invitations.get(id);
            if (!invitation || Date.parse(invitation.expiresAt) <= now()) {
                fail(error);
                return;
            }
            $(prefix + 'invite-link').focus();
            $(prefix + 'invite-link').select();
            toast('Select and copy the invite link above.');
        }
    }
    $('copy').onclick = () => copyInvitation();
    $('group-copy').onclick = () => copyInvitation('group-');
    $('regenerate').onclick = () => generateInvite().catch(fail);
    $('group-regenerate').onclick = () => generateInvite().catch(fail);

    async function shareInvitation() {
        const invitation = invitations.get(getRoom()?.id);
        if (!invitation || Date.parse(invitation.expiresAt) <= now()) {
            showInvite();
            return;
        }
        // Invoke in the click's user activation; never await a network request before sharing.
        try {
            await navigator.share({
                title: 'Join me on BlinkChat',
                url: location.origin + '/#invite=' + invitation.secret,
            });
        } catch (error) {
            if (error.name !== 'AbortError') toast('Sharing is unavailable. Use Copy invite link.');
        }
    }
    for (const prefix of ['', 'group-']) $(prefix + 'share').onclick = () => shareInvitation();
    return { showInvite, generateInvite };
}
