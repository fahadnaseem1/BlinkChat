// One set per page: no message bodies or invitation secrets are persisted in browser storage.
export function createRoomMemory() {
    return {
        drafts: new Map(),
        pending: new Map(),
        invitations: new Map(),
        copiedInvitations: new Map(),
        unreadRooms: new Set(),
    };
}

export function createRoomPresentation({ $, getRoom, getMe, getRooms, unreadRooms, open }) {
    function chatCode(r) {
        return r.code || r.id.slice(0, 6).toUpperCase();
    }

    function peerOf(r) {
        return r.participants?.find((p) => p.id !== getMe()?.id);
    }

    function chatLabel(r) {
        return (
            r.title ||
            ((r.participants?.length || 0) > 2
                ? `Group chat ${chatCode(r)}`
                : peerOf(r)
                  ? `Chat with ${peerOf(r).displayName}`
                  : `Chat ${chatCode(r)}`)
        );
    }

    // Conversation list and header rendering.
    function renderRooms() {
        const focused = document.activeElement?.dataset.roomId;
        const activeRooms = getRooms().filter((item) => ['active', 'waiting'].includes(item.state));
        $('room-count').textContent = activeRooms.length;
        $('chat-list-help').hidden = activeRooms.length > 0;
        $('rooms').replaceChildren();
        if (!activeRooms.length) {
            const note = document.createElement('p');
            note.className = 'room-list-empty';
            note.textContent = 'No chats yet. Start one and invite your friend.';
            $('rooms').append(note);
        }
        for (const state of ['active', 'waiting']) {
            const group = activeRooms.filter((r) => r.state === state);
            if (!group.length) {
                continue;
            }
            const heading = document.createElement('div');
            heading.className = 'room-group-label';
            heading.textContent = state === 'active' ? 'CHATTING' : 'WAITING FOR A FRIEND';
            $('rooms').append(heading);
            for (const r of group) {
                const selected = r.id === getRoom()?.id;
                const peer = peerOf(r);
                const b = document.createElement('button');
                b.className = 'room-item' + (selected ? ' selected' : '');
                b.dataset.roomId = r.id;
                if (selected) {
                    b.setAttribute('aria-current', 'true');
                }
                const avatar = document.createElement('span');
                avatar.className = 'avatar';
                avatar.textContent = peer?.displayName.slice(0, 1).toUpperCase() || '＋';
                const info = document.createElement('span');
                info.className = 'room-info';
                const name = document.createElement('strong');
                name.textContent = chatLabel(r);
                const status = document.createElement('small');
                status.textContent =
                    r.participants.length > 2
                        ? `${r.participants.length} members`
                        : peer
                          ? `With ${peer.displayName}`
                          : 'Share an invitation to start';
                info.append(name, status);
                b.append(avatar, info);
                if (unreadRooms.has(r.id)) {
                    const badge = document.createElement('span');
                    badge.className = 'room-badge';
                    badge.textContent = 'New message';
                    b.append(badge);
                    b.setAttribute('aria-label', `${chatLabel(r)}, new message`);
                }
                b.onclick = () => open(r.id);
                $('rooms').append(b);
            }
        }
        if (focused) {
            [...$('rooms').querySelectorAll('[data-room-id]')]
                .find((b) => b.dataset.roomId === focused)
                ?.focus();
        }
    }

    return { chatCode, peerOf, chatLabel, renderRooms };
}
