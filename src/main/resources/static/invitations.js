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
    getRooms,
    invitations,
    copiedInvitations,
    now,
    remaining,
    api,
    toast,
    fail,
}) {
    let qrFile;
    const requests = new Map();
    function canInvite() {
        const room = getRoom();
        return room && ['waiting', 'active'].includes(room.state) && room.creatorId === getMe()?.id;
    }
    function currentInvitation() {
        const invitation = canInvite() ? invitations.get(getRoom().id) : null;
        return invitation && Date.parse(invitation.expiresAt) > now() ? invitation : null;
    }
    function showInvite() {
        const invitation = currentInvitation();
        const url = invitation ? location.origin + '/#invite=' + invitation.secret : '';
        $('invite-link').value = url;
        $('invite-link').hidden = !invitation;
        $('invite-label').hidden = !invitation;
        $('copy').textContent =
            (copiedInvitations.get(getRoom()?.id) || 0) > performance.now()
                ? '✓ Copied!'
                : invitation
                  ? 'Copy link'
                  : 'Create link';
        $('share').hidden = !invitation || typeof navigator.share !== 'function';
        $('invite-expiry').textContent = invitation
            ? 'Link expires in ' + remaining(invitation.expiresAt)
            : 'Create a link to invite someone.';
        $('invite-management').hidden = !canInvite();
        $('regenerate').hidden = !canInvite();
        $('invite-qr-details').hidden = !invitation;
        const canvas = $('invite-qr');
        if (invitation && canvas.dataset.url !== url) {
            qrFile = null;
            $('qr-share').disabled = true;
            drawQr(canvas, url);
            canvas.dataset.url = url;
            canvas.toBlob((blob) => {
                if (!blob || canvas.dataset.url !== url) return;
                qrFile = new File([blob], 'blinkchat-invitation.png', { type: 'image/png' });
                $('qr-share').textContent = navigator.canShare?.({ files: [qrFile] })
                    ? 'Share QR'
                    : 'Save QR';
                $('qr-share').disabled = false;
            }, 'image/png');
        } else if (!invitation) {
            qrFile = null;
            canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
            delete canvas.dataset.url;
            $('qr-share').disabled = true;
            $('invite-qr-details').open = false;
        }
    }
    function openInvite() {
        if (!canInvite()) return;
        $('chat-details').hidePopover();
        showInvite();
        $('invite-dialog').showModal();
    }
    async function generateInvite() {
        if (!canInvite()) return;
        const id = getRoom().id;
        const guestId = getMe().id;
        if (requests.has(id)) return requests.get(id);
        copiedInvitations.delete(id);
        $('copy').disabled = $('regenerate').disabled = true;
        const request = api('/rooms/' + id + '/invites', 'POST')
            .then((invitation) => {
                // Late responses must not restore secrets for a departed room or session.
                if (
                    getMe()?.id === guestId &&
                    getRooms().some(
                        (room) =>
                            room.id === id &&
                            room.creatorId === guestId &&
                            ['waiting', 'active'].includes(room.state),
                    )
                ) {
                    invitations.set(id, invitation);
                    if (getRoom()?.id === id) showInvite();
                }
            })
            .finally(() => {
                requests.delete(id);
                $('copy').disabled = $('regenerate').disabled = requests.has(getRoom()?.id);
            });
        requests.set(id, request);
        return request;
    }
    $('copy').onclick = async () => {
        const id = getRoom()?.id;
        try {
            if (!currentInvitation()) await generateInvite();
            if (getRoom()?.id !== id || !currentInvitation()) return;
            await navigator.clipboard.writeText($('invite-link').value);
            copiedInvitations.set(id, performance.now() + 3000);
            showInvite();
            toast('Link copied.');
        } catch (error) {
            if (getRoom()?.id !== id) return;
            if (!currentInvitation()) return fail(error);
            $('invite-link').focus();
            $('invite-link').select();
            toast('Select the link to copy it.');
        }
    };
    $('regenerate').onclick = () =>
        generateInvite()
            .then(() => toast('Invitation replaced.'))
            .catch(fail);
    $('share').onclick = async () => {
        if (!currentInvitation()) return showInvite();
        try {
            await navigator.share({ title: 'Join me on BlinkChat', url: $('invite-link').value });
        } catch (error) {
            if (error.name !== 'AbortError') toast('Use Copy link to share this invitation.');
        }
    };
    $('qr-share').onclick = async () => {
        if (!currentInvitation() || !qrFile) return showInvite();
        try {
            if (navigator.canShare?.({ files: [qrFile] })) {
                await navigator.share({ files: [qrFile], title: 'BlinkChat invitation' });
            } else {
                const url = URL.createObjectURL(qrFile);
                const download = document.createElement('a');
                download.href = url;
                download.download = qrFile.name;
                document.body.append(download);
                download.click();
                download.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            }
        } catch (error) {
            if (error.name !== 'AbortError') toast('Couldn’t share the QR. Try saving the image.');
        }
    };
    return { showInvite, generateInvite, openInvite };
}
